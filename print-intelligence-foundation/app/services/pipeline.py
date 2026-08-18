import json
import logging
import math
from numbers import Real
import re
import tempfile
from time import monotonic
from pathlib import Path
import pikepdf
from PIL import Image
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.models import AdOccurrence, Document, Page, ReviewItem
from app.services.bbox import Box, deduplicate_boxes, iou, normalize_bbox
from app.services.classify import classify_page
from app.services.crop import crop_ad, restore_artwork
from app.services.content_anchors import (
    compare_content_anchors,
    compare_visual_motifs,
    extract_content_anchors,
    finding_messages,
)
from app.services.companies import XDATA_GERMANY, resolve_company
from app.services.extraction import extract_contact_fields
from app.services.ingest import content_lock, validate_pdf
from app.services.jobs import get_or_create, retry, run_stage
from app.services.order_forms import (
    FormParseResult,
    merge_form_and_ad_fields,
    parse_order_forms,
)
from app.services.ocr import OCRResult
from app.services.render import render_page, render_pdf
from app.services.restoration import (
    RestorationResult,
    approved_artwork_box,
    communication_lines_for_box,
    propose_level_one,
    verify_generative_proposal,
    verify_proposal,
)
from app.services.storage import sha256
from app.services.text_layer import (
    page_texts_in_boxes,
    page_text_in_box,
    remove_substring_bleed,
    watermark_markers_in_boxes,
)
from app.services.watermark_text_objects import (
    clean_pdf,
    verify_cleaned_ad,
)
from app.services.vision.image_edit import (
    ImageEditProvider,
    image_sha256,
    prepare_image_edit_input,
    restore_image_edit_output,
    select_image_edit_size,
)
from app.services.vision.image_edit_prompt import (
    IMAGE_EDIT_PROMPT,
    IMAGE_EDIT_PROMPT_SHA256,
    IMAGE_EDIT_PROMPT_VERSION,
)

logger = logging.getLogger(__name__)


class Pipeline:
    stages = ("download", "render", "classify", "detect", "extract", "store")

    def __init__(
        self,
        session: Session,
        provider,
        storage,
        render_dpi=120,
        confidence_threshold=0.7,
        max_attempts=3,
        stage_timeout_seconds=300,
        local_work_dir="./work",
        bbox_iou_threshold=0.85,
        artwork_dpi=300,
        artwork_padding=8,
        artwork_trim_cap=4,
        ocr_provider=None,
        ocr_confidence_threshold=None,
        vision_consensus_runs=1,
        restoration_enabled=False,
        image_edit_provider: ImageEditProvider | None = None,
        image_edit_max_cost_cents: int = 7,
        image_edit_hard_stop_cents: int = 1000,
        image_edit_max_attempts: int = 1,
        image_edit_color_tolerance: float = 0.12,
        watermark_markers: list[str] | None = None,
    ):
        self.session, self.provider, self.storage = session, provider, storage
        self.render_dpi, self.confidence_threshold = render_dpi, confidence_threshold
        self.max_attempts, self.stage_timeout_seconds = (
            max_attempts,
            stage_timeout_seconds,
        )
        self.local_work_dir = Path(local_work_dir)
        self.bbox_iou_threshold = bbox_iou_threshold
        self.artwork_dpi = artwork_dpi
        self.artwork_padding = artwork_padding
        self.artwork_trim_cap = artwork_trim_cap
        self.ocr_provider = ocr_provider
        self.ocr_confidence_threshold = (
            confidence_threshold
            if ocr_confidence_threshold is None
            else ocr_confidence_threshold
        )
        self.vision_consensus_runs = max(1, int(vision_consensus_runs))
        self.restoration_enabled = restoration_enabled
        self.image_edit_provider = image_edit_provider
        self.image_edit_max_cost_cents = max(0, int(image_edit_max_cost_cents))
        self.image_edit_hard_stop_cents = max(0, int(image_edit_hard_stop_cents))
        self.image_edit_max_attempts = max(1, int(image_edit_max_attempts))
        self.image_edit_color_tolerance = image_edit_color_tolerance
        self.watermark_markers = [
            marker.casefold().strip()
            for marker in (
                ["inixmedia"] if watermark_markers is None else watermark_markers
            )
            if marker.strip()
        ]
        self._restoration_cost_used = 0
        self._form_results: dict[int, FormParseResult] = {}
        self._form_results_source: str | None = None

    def source_path(self, digest: str) -> Path:
        return self.local_work_dir / digest / "source.pdf"

    def _run(self, document_id, stage, action, force=False):
        job = get_or_create(self.session, document_id, stage, self.max_attempts)
        if force:
            job.state, job.attempts, job.finished_at = "queued", 0, None
            job.last_error = None
            self.session.commit()
        elif job.state == "failed":
            retry(job)
            self.session.commit()
        run_stage(self.session, job, action, self.stage_timeout_seconds)

    def reprocess(self, pdf: bytes, filename="document.pdf", source_url=None):
        return self.ingest(pdf, filename, source_url, force=True)

    def ingest(self, pdf: bytes, filename="document.pdf", source_url=None, force=False):
        validate_pdf(pdf)
        digest = sha256(pdf)
        with content_lock(digest):
            return self._ingest_locked(pdf, filename, source_url, force, digest)

    def _ingest_locked(self, pdf, filename, source_url, force, digest):
        self._restoration_cost_used = 0
        doc = self.session.scalar(
            select(Document).where(Document.content_sha256 == digest)
        )
        if doc is None:
            doc = Document(
                content_sha256=digest, filename=filename, source_url=source_url
            )
            self.session.add(doc)
            try:
                self.session.commit()
            except IntegrityError:
                self.session.rollback()
                doc = self.session.scalar(
                    select(Document).where(Document.content_sha256 == digest)
                )
                if doc is None:
                    raise
        local_root = self.local_work_dir / digest
        local_root.mkdir(parents=True, exist_ok=True)
        source = self.source_path(digest)
        source.write_bytes(pdf)
        self.storage.put(pdf, f"{digest}/source.pdf")
        self._run(doc.id, "download", lambda: None, force)
        page_paths = []
        self._run(
            doc.id,
            "render",
            lambda deadline: page_paths.extend(
                render_pdf(source, local_root / "pages", self.render_dpi)
            ),
            force,
        )
        if not page_paths:
            page_paths = list((local_root / "pages").glob("page_*.png"))
        page_paths_by_number = self._page_paths_by_number(page_paths)
        self._run(
            doc.id,
            "classify",
            lambda deadline: self._classify_pages(doc, source, page_paths_by_number, deadline),
            force,
        )
        self._run(
            doc.id,
            "detect",
            lambda deadline: self._detect_pages(
                doc, source, page_paths_by_number, digest, local_root, deadline
            ),
            force,
        )
        self._run(doc.id, "extract", lambda deadline: self._extract_missing(doc, source, deadline), force)
        self._run(doc.id, "store", lambda: self.session.commit(), force)
        return doc

    @staticmethod
    def _page_paths_by_number(page_paths):
        paths = {}
        for path in page_paths:
            match = re.fullmatch(r"page_(\d+)", path.stem)
            if match:
                paths[int(match.group(1))] = path
        return dict(sorted(paths.items()))

    @staticmethod
    def _check_deadline(deadline):
        if monotonic() >= deadline:
            raise TimeoutError("stage deadline exceeded")

    def _classify_pages(self, doc, source, page_paths, deadline):
        self._get_form_results(source)
        for number, path in page_paths.items():
            self._check_deadline(deadline)
            page = self.session.scalar(
                select(Page).where(
                    Page.document_id == doc.id, Page.page_number == number
                )
            )
            classification = classify_page(source, number)
            if page is None:
                page = Page(
                    document_id=doc.id,
                    page_number=number,
                    image_path=str(path),
                    classification=classification,
                )
                self.session.add(page)
            else:
                page.image_path, page.classification = str(path), classification
            form = self._form_results[number]
            page.is_order_form = form.is_order_form
            page.form_header_json = form.as_json() if form.is_order_form else "{}"
        self.session.commit()

    def _prepare_watermark_cleaning(
        self,
        source,
        local_root,
        page_number,
        index,
        box,
        artwork_gate_holds,
        evidence,
    ):
        if not artwork_gate_holds or not evidence:
            return None
        try:
            cleaned_pdf = (
                local_root
                / "restoration_source"
                / f"watermark_cleaned_page_{page_number}_{index}.pdf"
            )
            cleaning = clean_pdf(
                source,
                cleaned_pdf,
                {page_number: [box]},
                self.watermark_markers,
                self.render_dpi,
            )
            return (
                cleaning.pdf_path,
                render_page(cleaning.pdf_path, page_number, self.artwork_dpi),
            )
        except (OSError, ValueError, TypeError, pikepdf.PdfError):
            logger.exception(
                "watermark text-object cleaning failed for page %s "
                "advertisement %s",
                page_number,
                index,
            )
            return None

    def _detect_pages(self, doc, source, page_paths, digest, local_root, deadline):
        for number, path in page_paths.items():
            self._check_deadline(deadline)
            page = self.session.scalar(
                select(Page).where(
                    Page.document_id == doc.id, Page.page_number == number
                )
            )
            with Image.open(path) as image:
                size = image.size
            candidates, unstable = self._detect_candidates(path, number, size)
            for count, runs in unstable:
                self._add_page_review(
                    page,
                    f"detection unstable: box appeared in {count}/{runs} runs",
                )
            artwork_page = (
                render_page(source, number, self.artwork_dpi) if candidates else None
            )
            boxes = deduplicate_boxes(
                [box for box, _ in candidates], self.bbox_iou_threshold
            )
            watermark_evidence = {}
            if (
                self.restoration_enabled
                and self.watermark_markers
                and boxes
            ):
                watermark_evidence = {
                    f"{box.left},{box.top},{box.right},{box.bottom}": evidence
                    for box, evidence in zip(
                        boxes,
                        watermark_markers_in_boxes(
                            source,
                            number,
                            boxes,
                            self.render_dpi,
                            self.watermark_markers,
                        ),
                    )
                }
            for index, box in enumerate(boxes):
                self._check_deadline(deadline)
                key = f"{box.left},{box.top},{box.right},{box.bottom}"
                advert = next(
                    (
                        ad
                        for candidate, ad in candidates
                        if candidate == box
                    ),
                    {},
                )
                existing = self.session.scalar(
                    select(AdOccurrence).where(
                        AdOccurrence.page_id == page.id,
                        AdOccurrence.occurrence_key == key,
                    )
                )
                if existing:
                    frame_plausible, artwork_gate_holds, gate_reason = (
                        self._artwork_gate(
                            page, existing.confidence, box, size
                        )
                    )
                    watermark_cleaning = (
                        self._prepare_watermark_cleaning(
                            source,
                            local_root,
                            number,
                            index,
                            box,
                            artwork_gate_holds,
                            watermark_evidence.get(key, []),
                        )
                        if artwork_gate_holds
                        else None
                    )
                    if (
                        artwork_page is not None
                        and not existing.artwork_path
                        and artwork_gate_holds
                    ):
                        artwork_output, padded_box = self._write_artwork(
                            existing, artwork_page, box, size, digest, number, index
                        )
                        self._maybe_write_restoration(
                            existing,
                            source,
                            number,
                            box,
                            size,
                            artwork_output,
                            padded_box,
                            digest,
                            page,
                            watermark_evidence.get(key, []),
                            watermark_cleaning,
                        )
                    elif (
                        self.restoration_enabled
                        and artwork_page is not None
                        and artwork_gate_holds
                    ):
                        padded_box = self._artwork_padded_box(
                            box, size, artwork_page.size
                        )
                        artwork_output = self._write_restoration_source(
                            artwork_page, padded_box, local_root, existing
                        )
                        self._maybe_write_restoration(
                            existing,
                            source,
                            number,
                            box,
                            size,
                            artwork_output,
                            padded_box,
                            digest,
                            page,
                            watermark_evidence.get(key, []),
                            watermark_cleaning,
                        )
                    elif self.restoration_enabled:
                        self._refuse_restoration(
                            existing,
                            gate_reason or "restoration refused: artwork is unavailable",
                            watermark_evidence.get(key, []),
                        )
                    self._add_order_form_reviews(
                        existing, page, frame_plausible
                    )
                    continue
                crop_path = crop_ad(
                    path, box, local_root / "crops" / f"page_{number}_{index}.png"
                )
                crop_key = f"{digest}/crops/page_{number}_{index}.png"
                self.storage.put_file(crop_path, crop_key)
                fields = {
                    **self.provider.extract_fields(str(crop_path)),
                    **(advert.get("fields") or {}),
                }
                provenance = {key: "vision" for key, value in fields.items() if value}
                occurrence = AdOccurrence(
                    page_id=page.id,
                    occurrence_key=key,
                    bbox=key,
                    data_source=XDATA_GERMANY,
                    crop_path=crop_key,
                    fields_json=json.dumps(
                        {
                            "text": "",
                            "fields": fields,
                            "provenance": provenance,
                        },
                        ensure_ascii=False,
                    ),
                    confidence=float(advert.get("confidence", 0)),
                    is_order_form=page.is_order_form,
                )
                self.session.add(occurrence)
                self.session.flush()
                frame_plausible, artwork_gate_holds, gate_reason = (
                    self._artwork_gate(
                        page, occurrence.confidence, box, size
                    )
                )
                watermark_cleaning = (
                    self._prepare_watermark_cleaning(
                        source,
                        local_root,
                        number,
                        index,
                        box,
                        artwork_gate_holds,
                        watermark_evidence.get(key, []),
                    )
                    if artwork_gate_holds
                    else None
                )
                if artwork_page is not None and artwork_gate_holds:
                    artwork_output, padded_box = self._write_artwork(
                        occurrence, artwork_page, box, size, digest, number, index
                    )
                    self._maybe_write_restoration(
                        occurrence,
                        source,
                        number,
                        box,
                        size,
                        artwork_output,
                        padded_box,
                        digest,
                        page,
                        watermark_evidence.get(key, []),
                        watermark_cleaning,
                    )
                elif self.restoration_enabled:
                    self._refuse_restoration(
                        occurrence,
                        gate_reason or "restoration refused: artwork is unavailable",
                        watermark_evidence.get(key, []),
                    )
                company_name = fields.get("company") or advert.get("company_name")
                if company_name and not page.is_order_form:
                    self._assign_company(occurrence, company_name, fields)
                if occurrence.confidence < self.confidence_threshold:
                    self._add_review(occurrence, "low confidence")
                self._add_order_form_reviews(occurrence, page, frame_plausible)
            self.session.commit()

    def _detect_candidates(self, path, page_number, size):
        if self.vision_consensus_runs == 1:
            ads = self.provider.detect_ads(str(path), page_number)
            candidates = []
            for advert in ads:
                box = normalize_bbox(
                    advert.get("bbox", []),
                    size,
                    tuple(advert["image_size"]) if advert.get("image_size") else None,
                )
                if box:
                    candidates.append((box, advert))
            return candidates, []

        runs = [
            self.provider.detect_ads(str(path), page_number)
            for _ in range(self.vision_consensus_runs)
        ]
        clusters = []
        for run_index, ads in enumerate(runs):
            for advert in ads:
                box = normalize_bbox(
                    advert.get("bbox", []),
                    size,
                    tuple(advert["image_size"]) if advert.get("image_size") else None,
                )
                if box is None:
                    continue
                cluster = next(
                    (
                        item
                        for item in clusters
                        if any(
                            iou(box, member_box) >= self.bbox_iou_threshold
                            for member_box, _, _ in item["members"]
                        )
                    ),
                    None,
                )
                if cluster is None:
                    cluster = {"members": []}
                    clusters.append(cluster)
                existing = next(
                    (
                        member
                        for member in cluster["members"]
                        if member[2] == run_index
                    ),
                    None,
                )
                if existing is None or float(advert.get("confidence", 0)) > float(
                    existing[1].get("confidence", 0)
                ):
                    if existing is not None:
                        cluster["members"].remove(existing)
                    cluster["members"].append((box, advert, run_index))

        candidates = []
        unstable = []
        for cluster in clusters:
            members = cluster["members"]
            run_count = len({run_index for _, _, run_index in members})
            if run_count <= self.vision_consensus_runs / 2:
                unstable.append((run_count, self.vision_consensus_runs))
                continue
            left = round(sum(box.left for box, _, _ in members) / len(members))
            top = round(sum(box.top for box, _, _ in members) / len(members))
            right = round(sum(box.right for box, _, _ in members) / len(members))
            bottom = round(sum(box.bottom for box, _, _ in members) / len(members))
            box = Box(left, top, right, bottom)
            average_confidence = sum(
                float(advert.get("confidence", 0)) for _, advert, _ in members
            ) / len(members)
            frequency = run_count / self.vision_consensus_runs
            confidence_weight = 1 / (self.vision_consensus_runs + 1)
            merged = {
                "confidence": (
                    (1 - confidence_weight) * frequency
                    + confidence_weight * average_confidence
                ),
            }
            keys = {
                key
                for _, advert, _ in members
                for key, value in advert.items()
                if key not in {"bbox", "confidence", "image_size"} and value
            }
            for key in keys:
                values = [
                    advert[key]
                    for _, advert, _ in members
                    if advert.get(key)
                ]
                groups = []
                for value in values:
                    group = next(
                        (group for group in groups if group[0] == value),
                        None,
                    )
                    if group is None:
                        groups.append([value, 1, 0.0])
                    else:
                        group[1] += 1
                for group in groups:
                    group[2] = max(
                        float(advert.get("confidence", 0))
                        for _, advert, _ in members
                        if advert.get(key) == group[0]
                    )
                merged[key] = max(groups, key=lambda group: (group[1], group[2]))[0]
            candidates.append((box, merged))
        return candidates, unstable

    @staticmethod
    def _order_form_box_is_plausible(box, page_size):
        if box is None:
            return False
        page_width, page_height = page_size
        area_ratio = box.area / (page_width * page_height)
        return (
            area_ratio <= 0.75
            and box.top >= page_height * 0.12
            and box.bottom <= page_height * 0.92
            and box.right - box.left <= page_width * 0.95
            and box.bottom - box.top <= page_height * 0.82
        )

    def _artwork_gate(self, page, confidence, box, page_size):
        frame_plausible = (
            not page.is_order_form
            or self._order_form_box_is_plausible(box, page_size)
        )
        if not page.is_order_form:
            return frame_plausible, True, None
        failures = []
        if confidence < self.confidence_threshold:
            failures.append("low confidence")
        if not frame_plausible:
            failures.append("implausible frame")
        if not failures:
            return frame_plausible, True, None
        return (
            frame_plausible,
            False,
            "restoration refused: order-form artwork gate failed ("
            + ", ".join(failures)
            + ")",
        )

    def _add_order_form_reviews(self, occurrence, page, frame_plausible):
        if page.is_order_form and not frame_plausible:
            self._add_review(
                occurrence,
                "order-form advert box failed geometric plausibility check",
            )
        if page.is_order_form and occurrence.confidence < self.confidence_threshold:
            self._add_review(occurrence, "low confidence")

    def _write_artwork(
        self, occurrence, artwork_page, box, detector_size, digest, number, index
    ):
        scale_x = artwork_page.width / detector_size[0]
        scale_y = artwork_page.height / detector_size[1]
        artwork_box = Box(
            round(box.left * scale_x),
            round(box.top * scale_y),
            round(box.right * scale_x),
            round(box.bottom * scale_y),
        )
        output = self.local_work_dir / digest / "artwork" / f"page_{number}_{index}.png"
        trimmed = (
            self.local_work_dir
            / digest
            / "artwork"
            / f"page_{number}_{index}_trimmed.png"
        )
        _, _, padded_box = restore_artwork(
            artwork_page,
            artwork_box,
            output,
            trimmed,
            self.artwork_padding,
            self.artwork_trim_cap,
        )
        occurrence.artwork_path = self.storage.put_file(
            output, f"{digest}/artwork/page_{number}_{index}.png"
        )
        occurrence.artwork_trimmed_path = self.storage.put_file(
            trimmed, f"{digest}/artwork/page_{number}_{index}_trimmed.png"
        )
        occurrence.artwork_metadata_json = json.dumps(
            {
                "detector_bbox": [box.left, box.top, box.right, box.bottom],
                "artwork_bbox": [
                    padded_box.left,
                    padded_box.top,
                    padded_box.right,
                    padded_box.bottom,
                ],
                "source_dpi": self.artwork_dpi,
                "padding": self.artwork_padding,
                "trim_cap": self.artwork_trim_cap,
            }
        )
        return output, padded_box

    def _write_cleaned_artwork(
        self, artwork_page, box, detector_size, digest, occurrence
    ):
        scale_x = artwork_page.width / detector_size[0]
        scale_y = artwork_page.height / detector_size[1]
        artwork_box = Box(
            round(box.left * scale_x),
            round(box.top * scale_y),
            round(box.right * scale_x),
            round(box.bottom * scale_y),
        )
        output = (
            self.local_work_dir
            / digest
            / "restoration_source"
            / f"watermark_occurrence_{occurrence.id}.png"
        )
        trimmed = output.with_name(f"{output.stem}_trimmed.png")
        _, _, padded_box = restore_artwork(
            artwork_page,
            artwork_box,
            output,
            trimmed,
            self.artwork_padding,
            self.artwork_trim_cap,
        )
        return output, padded_box

    def _artwork_padded_box(self, box, detector_size, artwork_size):
        scale_x = artwork_size[0] / detector_size[0]
        scale_y = artwork_size[1] / detector_size[1]
        artwork_box = Box(
            round(box.left * scale_x),
            round(box.top * scale_y),
            round(box.right * scale_x),
            round(box.bottom * scale_y),
        )
        return Box(
            max(0, artwork_box.left - self.artwork_padding),
            max(0, artwork_box.top - self.artwork_padding),
            min(artwork_size[0], artwork_box.right + self.artwork_padding),
            min(artwork_size[1], artwork_box.bottom + self.artwork_padding),
        )

    def _write_restoration_source(self, artwork_page, padded_box, local_root, occurrence):
        output = (
            local_root
            / "restoration_source"
            / f"occurrence_{occurrence.id}.png"
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        artwork_page.crop(
            (padded_box.left, padded_box.top, padded_box.right, padded_box.bottom)
        ).save(output, format="PNG", optimize=False)
        return output

    def _maybe_write_restoration(
        self,
        occurrence,
        source,
        page_number,
        box,
        detector_size,
        artwork_output,
        padded_box,
        digest,
        page,
        watermark_evidence=None,
        watermark_cleaning=None,
    ):
        if not self.restoration_enabled:
            return
        watermark_evidence = watermark_evidence or []
        deterministic_watermark_passed = False
        deterministic_candidate = False
        cleaning_verification = None
        deterministic_verification = None
        verification_source = source
        verification_artwork = artwork_output
        verification_origin = (padded_box.left, padded_box.top)
        if watermark_evidence and watermark_cleaning is not None:
            cleaned_pdf, cleaned_page = watermark_cleaning
            cleaning_verification = verify_cleaned_ad(
                source,
                cleaned_pdf,
                page_number,
                box,
                self.watermark_markers,
                self.render_dpi,
                self.artwork_dpi,
            )
            if cleaning_verification.passed:
                cleaned_artwork, cleaned_padded_box = (
                    self._write_cleaned_artwork(
                        cleaned_page,
                        box,
                        detector_size,
                        digest,
                        occurrence,
                    )
                )
                result = propose_level_one(
                    cleaned_pdf,
                    page_number,
                    box,
                    self.render_dpi,
                    cleaned_artwork,
                    (cleaned_padded_box.left, cleaned_padded_box.top),
                    self.artwork_dpi,
                )
                result.manifest.update(
                    {
                        "cascade_level": 2,
                        "restoration_stage": "deterministic_text_object",
                        "watermark": {
                            "detected": True,
                            "markers": watermark_evidence,
                            "source": "pdf_text_layer",
                        },
                        "watermark_text_objects": {
                            "method": "pikepdf_text_object_removal",
                            "provenance": {
                                "original_pdf": str(source),
                                "cleaned_pdf": str(cleaned_pdf),
                                "page": page_number,
                            },
                            "verification": cleaning_verification.as_dict(),
                        },
                    }
                )
                deterministic_candidate = result.image is not None
                verification_source = cleaned_pdf
                verification_artwork = cleaned_artwork
                verification_origin = (
                    cleaned_padded_box.left,
                    cleaned_padded_box.top,
                )
            else:
                result = RestorationResult(
                    image=None,
                    manifest={
                        "cascade_level": 2,
                        "geometry_quality": {
                            "status": "not_assessed",
                            "text_characters": None,
                            "invalid_ratio": None,
                            "overlap_ratio": None,
                        },
                        "verification": {"status": "not_assessed", "checks": []},
                        "watermark": {
                            "detected": True,
                            "markers": watermark_evidence,
                            "source": "pdf_text_layer",
                        },
                        "watermark_text_objects": {
                            "method": "pikepdf_text_object_removal",
                            "provenance": {
                                "original_pdf": str(source),
                                "cleaned_pdf": str(cleaned_pdf),
                                "page": page_number,
                            },
                            "verification": cleaning_verification.as_dict(),
                        },
                        "deterministic_restoration": {
                            "status": "refused",
                            "reason": (
                                "The cleaned PDF failed one or more "
                                "losslessness checks."
                            ),
                        },
                        "findings": [],
                        "review_status": "pending",
                        "edit_status": "refused",
                    },
                    review_reason=(
                        "watermark text-object cleaning verification failed; "
                        "falling back to generative restoration"
                    ),
                )
        elif watermark_evidence:
            reason = (
                "watermark detected in PDF text layer; deterministic "
                "pixel-shift restoration is insufficient"
            )
            result = RestorationResult(
                image=None,
                manifest={
                    "cascade_level": 2,
                    "watermark": {
                        "detected": True,
                        "markers": watermark_evidence,
                        "source": "pdf_text_layer",
                    },
                    "deterministic_restoration": {
                        "status": "refused",
                        "reason": reason,
                    },
                    "geometry_quality": {
                        "status": "not_assessed",
                        "text_characters": None,
                        "invalid_ratio": None,
                        "overlap_ratio": None,
                    },
                    "findings": [],
                    "verification": {"status": "not_assessed", "checks": []},
                    "review_status": "pending",
                    "edit_status": "refused",
                },
                review_reason=reason,
            )
        else:
            result = propose_level_one(
                source,
                page_number,
                box,
                self.render_dpi,
                artwork_output,
                (padded_box.left, padded_box.top),
                self.artwork_dpi,
            )
        proposal_image = result.image
        review_reason = result.review_reason
        if proposal_image is not None:
            fields = json.loads(occurrence.fields_json).get("fields", {})
            verification = verify_proposal(
                verification_source,
                page_number,
                box,
                self.render_dpi,
                verification_artwork,
                proposal_image,
                verification_origin,
                self.artwork_dpi,
                result.manifest,
                [str(value) for value in fields.values() if value],
            )
            if cleaning_verification is not None:
                cleaning_checks = [
                    {
                        "name": f"watermark_{name}",
                        **check,
                    }
                    for name, check in cleaning_verification.as_dict().items()
                    if isinstance(check, dict)
                ]
                verification["checks"].extend(cleaning_checks)
                verification["status"] = (
                    "passed"
                    if verification["status"] == "passed"
                    and cleaning_verification.passed
                    else "failed"
                )
            result.manifest["verification"] = verification
            if cleaning_verification is not None:
                deterministic_verification = verification
            if verification["status"] != "passed":
                proposal_image = None
                review_reason = (
                    "restoration refused: independent verification failed"
                )
                result.manifest["cascade_justification"] = (
                    "Refused: independent restoration verification failed."
                )
                result.manifest["edit_status"] = "refused"
            else:
                result.manifest["restoration_mode"] = (
                    "deterministic_text_object"
                    if cleaning_verification is not None
                    else "pixel_shift"
                )
                deterministic_watermark_passed = (
                    cleaning_verification is not None
                )
                if deterministic_watermark_passed:
                    result.manifest.update(
                        {
                            "deterministic_restoration": {
                                "status": "passed",
                                "reason": (
                                    "The cleaned PDF and independent restoration "
                                    "verification both passed."
                                ),
                            },
                            "review_status": "not_required",
                            "review_exemption_reason": (
                                "Human review is not required because the "
                                "deterministic PDF cleaning and independent "
                                "verification both passed."
                            ),
                            "edit_status": "applied",
                        }
                    )
        if (
            cleaning_verification is not None
            and not deterministic_watermark_passed
        ):
            result.manifest["deterministic_restoration"] = {
                "status": "refused",
                "reason": (
                    "Independent verification of the cleaned PDF restoration "
                    "failed."
                    if deterministic_candidate
                    else (
                        result.review_reason
                        or "Level-one restoration produced no image."
                    )
                ),
            }
            result.manifest["review_status"] = "pending"
            result.manifest["edit_status"] = "refused"
        if proposal_image is None and self.image_edit_provider is not None:
            proposal_image, review_reason = self._try_generative_restoration(
                result,
                source,
                page_number,
                box,
                artwork_output,
                padded_box,
                occurrence,
            )
            if deterministic_verification is not None:
                result.manifest["verification"]["checks"].extend(
                    {
                        "name": f"deterministic_{check['name']}",
                        **check,
                    }
                    for check in deterministic_verification["checks"]
                )
                if deterministic_verification["status"] != "passed":
                    result.manifest["verification"]["status"] = "failed"
        if watermark_evidence and not deterministic_watermark_passed:
            result.manifest["watermark"] = {
                "detected": True,
                "markers": watermark_evidence,
                "source": "pdf_text_layer",
            }
            result.manifest["cascade_level"] = 2
            result.manifest.setdefault(
                "deterministic_restoration",
                {
                    "status": "refused",
                    "reason": (
                        "Watermark remains in a deterministic PDF render; "
                        "pixel-shift restoration is insufficient."
                    ),
                },
            )
            if proposal_image is None:
                result.manifest["edit_status"] = "refused"
                result.manifest["review_status"] = "pending"
                if self.image_edit_provider is None:
                    generative_reason = (
                        "watermark detected; generative restoration is not configured"
                    )
                else:
                    generative_reason = (
                        review_reason
                        or "restoration refused: generative restoration failed"
                    )
                result.manifest["cascade_justification"] = (
                    "Refused deterministic restoration because the PDF text layer "
                    "marks this advertisement with a watermark; "
                    f"{generative_reason}."
                )
                review_reason = generative_reason
        elif watermark_evidence:
            result.manifest["watermark"] = {
                "detected": True,
                "markers": watermark_evidence,
                "source": "pdf_text_layer",
            }
            result.manifest["cascade_level"] = 2
        if proposal_image is not None:
            original_image = Image.open(artwork_output).convert("RGB")
            fields = json.loads(occurrence.fields_json or "{}").get("fields", {})
            company_name = fields.get("company") or fields.get("company_name")
            ocr_size = (
                max(original_image.width, proposal_image.width),
                max(original_image.height, proposal_image.height),
            )
            original_anchors = extract_content_anchors(
                original_image,
                company_name=company_name,
                ocr_size=ocr_size,
            )
            restored_anchors = extract_content_anchors(
                proposal_image,
                company_name=company_name,
                ocr_size=ocr_size,
            )
            comparison = compare_content_anchors(
                original_anchors,
                restored_anchors,
                watermark_markers=self.watermark_markers,
            )
            excluded_lost_regions = []
            if (
                comparison["qr_removed"]
                and original_anchors.get("qr_detection") == "available"
                and original_anchors.get("qr_region")
            ):
                excluded_lost_regions.append(original_anchors["qr_region"])
            visual_comparison = compare_visual_motifs(
                original_image,
                proposal_image,
                excluded_lost_regions=excluded_lost_regions,
            )
            comparison["findings"].extend(visual_comparison["findings"])
            comparison["status"] = comparison["severity"] = (
                "abweichung"
                if any(
                    finding.get("severity") == "abweichung"
                    for finding in comparison["findings"]
                )
                else "unsicher"
                if comparison["findings"]
                else "passed"
            )
            result.manifest["content_anchors"] = {
                "original": original_anchors,
                "restored": restored_anchors,
            }
            result.manifest["content_comparison"] = comparison
            result.manifest["qr_removed"] = comparison["qr_removed"]
            result.manifest["watermark_removed"] = comparison["watermark_removed"]
            result.manifest["watermark_comparison"] = {
                "markers_original": comparison["watermark_markers_original"],
                "markers_restored": comparison["watermark_markers_restored"],
                "removed_intentionally": comparison["watermark_removed"],
            }
            result.manifest["visual_comparison"] = visual_comparison
            messages = finding_messages(comparison)
            if messages:
                review_reason = "; ".join(
                    reason for reason in [review_reason, *messages] if reason
                )
            if not review_reason and not deterministic_watermark_passed:
                review_reason = (
                    "Restaurierungsvorschlag wartet auf menschliche Freigabe"
                )
            if watermark_evidence and not deterministic_watermark_passed:
                review_reason = (
                    "watermark restoration always requires human review; "
                    + review_reason
                )
        occurrence.restoration_manifest_json = json.dumps(
            result.manifest, ensure_ascii=False
        )
        if proposal_image is not None:
            output = (
                self.local_work_dir
                / digest
                / "restoration"
                / f"occurrence_{occurrence.id}.png"
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            proposal_image.save(output, format="PNG", optimize=False)
            occurrence.restoration_path = self.storage.put_file(
                output, f"{digest}/restoration/occurrence_{occurrence.id}.png"
            )
        else:
            occurrence.restoration_path = None
        if review_reason:
            self._add_review(occurrence, review_reason)

    def _try_generative_restoration(
        self,
        pixel_result,
        source,
        page_number,
        detector_box,
        artwork_output,
        padded_box,
        occurrence,
    ):
        manifest = pixel_result.manifest
        artwork = Image.open(artwork_output).convert("RGB")
        boundary = approved_artwork_box(
            detector_box,
            artwork.size,
            self.render_dpi,
            self.artwork_dpi,
            (padded_box.left, padded_box.top),
        )
        if boundary.area <= 0:
            manifest["generative"] = {
                "status": "refused",
                "reason": "approved advertisement boundary is empty",
            }
            return None, "restoration refused: approved advertisement boundary is empty"
        previous_reasons = [pixel_result.review_reason] if pixel_result.review_reason else []
        fields = json.loads(occurrence.fields_json or "{}").get("fields", {})
        expected = communication_lines_for_box(
            source,
            page_number,
            detector_box,
            self.render_dpi,
            self.artwork_dpi,
            (padded_box.left, padded_box.top),
        )
        expected.extend(str(value) for value in fields.values() if value)
        original_crop = artwork.crop(
            (boundary.left, boundary.top, boundary.right, boundary.bottom)
        )
        requested_format, requested_size = select_image_edit_size(original_crop.size)
        prepared_crop, fitted_region = prepare_image_edit_input(
            original_crop, requested_size
        )
        normalization = {
            "requested_format": requested_format,
            "requested_size": list(requested_size),
            "fitted_region": list(fitted_region),
            "source_size": list(original_crop.size),
            "normalized_size": [
                fitted_region[2] - fitted_region[0],
                fitted_region[3] - fitted_region[1],
            ],
            "resampling": "LANCZOS",
            "output_lower_resolution": (
                (fitted_region[2] - fitted_region[0])
                * (fitted_region[3] - fitted_region[1])
                < original_crop.width * original_crop.height
            ),
        }
        original_ocr_text = ""
        for attempt in range(self.image_edit_max_attempts):
            if (
                self._restoration_cost_used + self.image_edit_max_cost_cents
                > self.image_edit_hard_stop_cents
            ):
                manifest["generative"] = {
                    "status": "refused",
                    "attempt": attempt + 1,
                    "cost": 0,
                    "document_cost_cents": self._restoration_cost_used,
                    "reason": "image edit hard stop reached before provider call",
                }
                return None, "restoration refused: image edit cost hard stop"
            self._restoration_cost_used += self.image_edit_max_cost_cents
            try:
                edited = self.image_edit_provider.edit(
                    prepared_crop,
                    IMAGE_EDIT_PROMPT,
                    previous_reasons,
                    requested_format,
                )
                reported = edited.reported_cost
                reported_cents = (
                    int(round(reported))
                    if isinstance(reported, Real)
                    and not isinstance(reported, bool)
                    and math.isfinite(reported)
                    else 0
                )
                charged = max(self.image_edit_max_cost_cents, reported_cents)
                provider_image = edited.image
                provider_size = provider_image.size
            except (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                IndexError,
                AttributeError,
                OverflowError,
            ) as exc:
                manifest["generative"] = {
                    "status": "refused",
                    "attempt": attempt + 1,
                    "cost": self.image_edit_max_cost_cents,
                    "document_cost_cents": self._restoration_cost_used,
                    "reason": f"image edit provider failed: {exc}",
                }
                return None, "restoration refused: image edit provider failed"
            self._restoration_cost_used += max(
                0, charged - self.image_edit_max_cost_cents
            )
            if provider_size != requested_size:
                verification = {
                    "status": "failed",
                    "checks": [
                        {
                            "name": "dimensions",
                            "status": "failed",
                            "reason": "provider result dimensions differ from requested format",
                            "requested_size": list(requested_size),
                            "provided_size": list(provider_size),
                        }
                    ],
                }
                manifest["generative"] = {
                    "status": "failed",
                    "provider": type(self.image_edit_provider).__name__,
                    "model": edited.model,
                    "prompt_version": IMAGE_EDIT_PROMPT_VERSION,
                    "prompt_sha256": IMAGE_EDIT_PROMPT_SHA256,
                    "input_sha256": image_sha256(original_crop),
                    "output_sha256": image_sha256(provider_image),
                    "attempt": attempt + 1,
                    "cost": charged,
                    "document_cost_cents": self._restoration_cost_used,
                    "verification": verification,
                    "pixel_stage_reason": pixel_result.review_reason,
                    "review_required": True,
                    "normalization": normalization,
                }
                manifest["verification"] = verification
                previous_reasons = [verification["checks"][0]["reason"]]
                continue
            normalized_image = restore_image_edit_output(
                provider_image, fitted_region, original_crop.size
            )
            with tempfile.NamedTemporaryFile(suffix=".png") as original_file, tempfile.NamedTemporaryFile(
                suffix=".png"
            ) as result_file:
                original_crop.save(original_file.name, format="PNG", optimize=False)
                normalized_image.save(result_file.name, format="PNG", optimize=False)
                original_ocr_result = None
                if self.ocr_provider is not None:
                    original_ocr_result = self.ocr_provider.extract_fields(
                        original_file.name
                    )
                    result_ocr_result = self.ocr_provider.extract_fields(
                        result_file.name
                    )
                    result_ocr_text = result_ocr_result.text
                    if original_ocr_result.confidence and max(
                        original_ocr_result.confidence.values()
                    ) >= self.ocr_confidence_threshold:
                        original_ocr_text = (
                            original_ocr_result.text + "\n" + "\n".join(expected)
                        )
                    else:
                        original_ocr_text = ""
                else:
                    result_ocr_text = ""
            composed = artwork.copy()
            composed.paste(
                normalized_image.convert("RGB"), (boundary.left, boundary.top)
            )
            verification = verify_generative_proposal(
                artwork,
                composed,
                boundary,
                expected,
                original_ocr_text,
                result_ocr_text,
                self.image_edit_color_tolerance,
                normalized_image.size,
            )
            manifest["generative"] = {
                "status": verification["status"],
                "provider": type(self.image_edit_provider).__name__,
                "model": edited.model,
                "prompt_version": IMAGE_EDIT_PROMPT_VERSION,
                "prompt_sha256": IMAGE_EDIT_PROMPT_SHA256,
                "input_sha256": image_sha256(original_crop),
                "output_sha256": image_sha256(normalized_image),
                "attempt": attempt + 1,
                "cost": charged,
                "document_cost_cents": self._restoration_cost_used,
                "verification": verification,
                "pixel_stage_reason": pixel_result.review_reason,
                "review_required": True,
                "normalization": normalization,
            }
            manifest["verification"] = verification
            if verification["status"] == "passed":
                manifest["ad_boundary"] = [
                    boundary.left,
                    boundary.top,
                    boundary.right,
                    boundary.bottom,
                ]
                manifest["cascade_justification"] = (
                    "Generative restoration passed independent verification; "
                    "human review is required."
                )
                manifest["restoration_mode"] = "generative"
                manifest["edit_status"] = "applied"
                manifest["review_status"] = "pending"
                return (
                    composed,
                    "generative restoration proposal requires human review; "
                    + (pixel_result.review_reason or "pixel stage refused"),
                )
            previous_reasons = [
                check.get("reason", "")
                for check in verification.get("checks", [])
                if check.get("status") != "passed" and check.get("reason")
            ]
        return None, "restoration refused: generative verification failed"

    def _refuse_restoration(self, occurrence, reason, watermark_evidence=None):
        manifest = {
            "cascade_level": 1,
            "cascade_justification": reason,
            "source_regions": [],
            "destination_regions": [],
            "removed_regions": [],
            "background_regions": [],
            "protected_regions": [],
            "ad_boundary": [],
            "geometry_quality": {
                "status": "not_assessed",
                "text_characters": None,
                "invalid_ratio": None,
                "overlap_ratio": None,
            },
            "findings": [],
            "verification": {"status": "not_assessed", "checks": []},
            "review_status": "pending",
            "edit_status": "refused",
        }
        if watermark_evidence:
            manifest["watermark"] = {
                "detected": True,
                "markers": watermark_evidence,
                "source": "pdf_text_layer",
            }
        occurrence.restoration_manifest_json = json.dumps(
            manifest,
            ensure_ascii=False,
        )
        occurrence.restoration_path = None
        self._add_review(occurrence, reason)

    def _extract_missing(self, doc, source, deadline):
        for page in self.session.scalars(
            select(Page).where(Page.document_id == doc.id)
        ):
            self._check_deadline(deadline)
            extracted = []
            occurrences = list(page.ads)
            boxes = [
                Box(*(int(value) for value in occurrence.bbox.split(",")))
                for occurrence in occurrences
            ]
            page_text = page_text_in_box(
                source,
                page.page_number,
                Box(0, 0, 10_000, 10_000),
                self.render_dpi,
            )
            texts = remove_substring_bleed(
                page_texts_in_boxes(source, page.page_number, boxes, self.render_dpi),
                page_text,
            )
            for occurrence, text in zip(occurrences, texts):
                data = json.loads(occurrence.fields_json or "{}")
                extracted.append((occurrence, data, text))
            form = self._get_form_results(source)[page.page_number]
            for occurrence, data, text in extracted:
                self._check_deadline(deadline)
                fields = extract_contact_fields(
                    text, occurrence.company.name if occurrence.company else None
                ).model_dump(exclude_none=True)
                provenance = {
                    key: "text_layer" for key, value in fields.items() if value
                }
                for key, value in data.get("fields", {}).items():
                    if value:
                        fields[key] = value
                        provenance[key] = data.get("provenance", {}).get(
                            key, "vision"
                        )
                self._apply_ocr(
                    fields,
                    provenance,
                    data,
                    occurrence,
                    doc,
                )
                data["text"], data["advert_fields"] = text, fields
                data["provenance"] = provenance
                if page.is_order_form:
                    data["form_header"] = {
                        "fields": form.fields,
                        "metadata": form.metadata,
                        "complete": form.complete,
                    }
                    merged, conflicts = merge_form_and_ad_fields(form.fields, fields)
                    data["fields"], data["field_conflicts"] = merged, conflicts
                    data["provenance"] = {
                        key: (
                            "order_form_header"
                            if key in form.fields and form.fields[key]
                            else provenance.get(key, "vision")
                        )
                        for key, value in merged.items()
                        if value
                    }
                    occurrence.is_order_form = True
                    for key, conflict in conflicts.items():
                        self._add_review(
                            occurrence,
                            f"header/advert conflict for {key}: "
                            f"{conflict['header']} != {conflict['advert']}",
                        )
                    if not form.complete:
                        self._add_review(
                            occurrence, "incomplete or missing order-form header"
                        )
                    elif form.fields.get("company") and not occurrence.company:
                        self._assign_company(
                            occurrence, form.fields["company"], form.fields
                        )
                else:
                    data["fields"] = fields
                    if fields.get("company") and not occurrence.company:
                        self._assign_company(occurrence, fields["company"], fields)
                    if (
                        not fields.get("phone")
                        and not fields.get("email")
                        and not self.session.scalar(
                            select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)
                        )
                    ):
                        self._add_review(occurrence, "incomplete contact fields")
                occurrence.fields_json = json.dumps(data, ensure_ascii=False)
        self.session.commit()

    def _apply_ocr(self, fields, provenance, data, occurrence, doc):
        if self.ocr_provider is None or not occurrence.crop_path:
            return
        crop_path = (
            self.local_work_dir
            / doc.content_sha256
            / "crops"
            / Path(occurrence.crop_path).name
        )
        if not crop_path.is_file():
            return
        try:
            result: OCRResult = self.ocr_provider.extract_fields(str(crop_path))
        except Exception as exc:
            logger.warning("OCR fallback failed for %s: %s", crop_path, exc)
            return
        ocr_data = data.setdefault("ocr", {"fields": {}, "confidence": {}})
        for key, value in result.fields.items():
            if fields.get(key):
                continue
            fields[key] = value
            provenance[key] = "ocr"
            confidence = float(result.confidence.get(key, 0.0))
            ocr_data["fields"][key] = value
            ocr_data["confidence"][key] = confidence
            if confidence < self.ocr_confidence_threshold:
                self._add_review(occurrence, f"low confidence OCR field: {key}")

    def _get_form_results(self, source):
        source_key = str(Path(source).resolve())
        if self._form_results_source != source_key:
            self._form_results = parse_order_forms(source)
            self._form_results_source = source_key
        return self._form_results

    def _add_review(self, occurrence, reason):
        review = self.session.scalar(
            select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)
        )
        if review is None:
            self.session.add(ReviewItem(ad_id=occurrence.id, reason=reason))
        elif reason not in review.reason.split("; "):
            review.reason = f"{review.reason}; {reason}"

    def _add_page_review(self, page, reason):
        review = next(
            (
                item
                for item in self.session.new
                if isinstance(item, ReviewItem)
                and item.page_id == page.id
                and item.ad_id is None
            ),
            None,
        )
        if review is None:
            review = self.session.scalar(
                select(ReviewItem).where(
                    ReviewItem.page_id == page.id,
                    ReviewItem.ad_id.is_(None),
                )
            )
        if review is None:
            self.session.add(ReviewItem(page_id=page.id, reason=reason))
        elif reason not in review.reason.split("; "):
            review.reason = f"{review.reason}; {reason}"

    def _assign_company(self, occurrence, name, fields):
        occurrence.company = resolve_company(
            self.session, name, fields, XDATA_GERMANY
        )
