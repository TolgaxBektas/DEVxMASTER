import json
import logging
import re
from time import monotonic
from pathlib import Path
from PIL import Image
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.models import AdOccurrence, Company, Document, Page, ReviewItem
from app.services.bbox import Box, deduplicate_boxes, iou, normalize_bbox
from app.services.classify import classify_page
from app.services.crop import crop_ad, restore_artwork
from app.services.dedupe import contact_key, normalize_name
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
from app.services.restoration import propose_level_one
from app.services.storage import sha256
from app.services.text_layer import (
    page_texts_in_boxes,
    page_text_in_box,
    remove_substring_bleed,
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
            for index, box in enumerate(boxes):
                self._check_deadline(deadline)
                advert = next(ad for candidate, ad in candidates if candidate == box)
                key = f"{box.left},{box.top},{box.right},{box.bottom}"
                existing = self.session.scalar(
                    select(AdOccurrence).where(
                        AdOccurrence.page_id == page.id,
                        AdOccurrence.occurrence_key == key,
                    )
                )
                if existing:
                    frame_plausible = (
                        not page.is_order_form
                        or self._order_form_box_is_plausible(box, size)
                    )
                    if (
                        artwork_page is not None
                        and not existing.artwork_path
                        and (
                            not page.is_order_form
                            or (
                                existing.confidence >= self.confidence_threshold
                                and frame_plausible
                            )
                        )
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
                        )
                    elif self.restoration_enabled and artwork_page is not None:
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
                        )
                    elif self.restoration_enabled:
                        self._refuse_restoration(
                            existing, "restoration refused: artwork is unavailable"
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
                frame_plausible = (
                    not page.is_order_form
                    or self._order_form_box_is_plausible(box, size)
                )
                if artwork_page is not None and (
                    not page.is_order_form
                    or (
                        occurrence.confidence >= self.confidence_threshold
                        and frame_plausible
                    )
                ):
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
                    )
                elif self.restoration_enabled:
                    self._refuse_restoration(
                        occurrence, "restoration refused: artwork is unavailable"
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
    ):
        if not self.restoration_enabled:
            return
        result = propose_level_one(
            source,
            page_number,
            box,
            self.render_dpi,
            artwork_output,
            (padded_box.left, padded_box.top),
            self.artwork_dpi,
        )
        occurrence.restoration_manifest_json = json.dumps(
            result.manifest, ensure_ascii=False
        )
        if result.image is not None:
            output = (
                self.local_work_dir
                / digest
                / "restoration"
                / f"occurrence_{occurrence.id}.png"
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            result.image.save(output, format="PNG", optimize=False)
            occurrence.restoration_path = self.storage.put_file(
                output, f"{digest}/restoration/occurrence_{occurrence.id}.png"
            )
        else:
            occurrence.restoration_path = None
        if result.review_reason:
            self._add_review(occurrence, result.review_reason)

    def _refuse_restoration(self, occurrence, reason):
        occurrence.restoration_manifest_json = json.dumps(
            {
                "cascade_level": 1,
                "cascade_justification": reason,
                "source_regions": [],
                "destination_regions": [],
                "removed_regions": [],
                "background_regions": [],
                "protected_regions": [],
                "ad_boundary": [],
                "findings": [],
                "review_status": "pending",
                "edit_status": "refused",
            },
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
        normalized, key = normalize_name(name), contact_key(fields)
        company = self.session.scalar(
            select(Company).where(
                Company.normalized_name == normalized, Company.contact_key == key
            )
        )
        if company is None:
            company = Company(name=name, normalized_name=normalized, contact_key=key)
            self.session.add(company)
            self.session.flush()
        occurrence.company = company
