import json
import re
from time import monotonic
from pathlib import Path
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.models import AdOccurrence, Company, Document, Page, ReviewItem
from app.services.bbox import Box, deduplicate_boxes, normalize_bbox
from app.services.classify import classify_page
from app.services.crop import crop_ad
from app.services.dedupe import contact_key, normalize_name
from app.services.extraction import extract_contact_fields
from app.services.jobs import get_or_create, retry, run_stage
from app.services.render import render_pdf
from app.services.storage import sha256
from app.services.text_layer import (
    page_texts_in_boxes,
    page_text_in_box,
    remove_substring_bleed,
)


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
    ):
        self.session, self.provider, self.storage = session, provider, storage
        self.render_dpi, self.confidence_threshold = render_dpi, confidence_threshold
        self.max_attempts, self.stage_timeout_seconds = (
            max_attempts,
            stage_timeout_seconds,
        )
        self.local_work_dir = Path(local_work_dir)
        self.bbox_iou_threshold = bbox_iou_threshold

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
        digest = sha256(pdf)
        doc = self.session.scalar(
            select(Document).where(Document.content_sha256 == digest)
        )
        if doc is None:
            doc = Document(
                content_sha256=digest, filename=filename, source_url=source_url
            )
            self.session.add(doc)
            self.session.commit()
        local_root = self.local_work_dir / digest
        local_root.mkdir(parents=True, exist_ok=True)
        source = local_root / "source.pdf"
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
            lambda deadline: self._detect_pages(doc, page_paths_by_number, digest, local_root, deadline),
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
        for number, path in page_paths.items():
            self._check_deadline(deadline)
            page = self.session.scalar(
                select(Page).where(
                    Page.document_id == doc.id, Page.page_number == number
                )
            )
            classification = classify_page(source, number)
            if page is None:
                self.session.add(
                    Page(
                        document_id=doc.id,
                        page_number=number,
                        image_path=str(path),
                        classification=classification,
                    )
                )
            else:
                page.image_path, page.classification = str(path), classification
        self.session.commit()

    def _detect_pages(self, doc, page_paths, digest, local_root, deadline):
        for number, path in page_paths.items():
            self._check_deadline(deadline)
            page = self.session.scalar(
                select(Page).where(
                    Page.document_id == doc.id, Page.page_number == number
                )
            )
            ads = self.provider.detect_ads(str(path), number)
            with Image.open(path) as image:
                size = image.size
            candidates = []
            for advert in ads:
                box = normalize_bbox(
                    advert.get("bbox", []),
                    size,
                    tuple(advert["image_size"]) if advert.get("image_size") else None,
                )
                if box:
                    candidates.append((box, advert))
            boxes = deduplicate_boxes(
                [box for box, _ in candidates], self.bbox_iou_threshold
            )
            for index, box in enumerate(boxes):
                self._check_deadline(deadline)
                advert = next(ad for candidate, ad in candidates if candidate == box)
                key = f"{box.left},{box.top},{box.right},{box.bottom}"
                if self.session.scalar(
                    select(AdOccurrence).where(
                        AdOccurrence.page_id == page.id,
                        AdOccurrence.occurrence_key == key,
                    )
                ):
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
                occurrence = AdOccurrence(
                    page_id=page.id,
                    occurrence_key=key,
                    bbox=key,
                    crop_path=crop_key,
                    fields_json=json.dumps(
                        {"text": "", "fields": fields}, ensure_ascii=False
                    ),
                    confidence=float(advert.get("confidence", 0)),
                )
                self.session.add(occurrence)
                self.session.flush()
                company_name = fields.get("company") or advert.get("company_name")
                if company_name:
                    self._assign_company(occurrence, company_name, fields)
                if occurrence.confidence < self.confidence_threshold:
                    self.session.add(
                        ReviewItem(ad_id=occurrence.id, reason="low confidence")
                    )
            self.session.commit()

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
            for occurrence, data, text in extracted:
                self._check_deadline(deadline)
                fields = extract_contact_fields(
                    text, occurrence.company.name if occurrence.company else None
                ).model_dump(exclude_none=True)
                fields.update({k: v for k, v in data.get("fields", {}).items() if v})
                data["text"], data["fields"] = text, fields
                occurrence.fields_json = json.dumps(data, ensure_ascii=False)
                if fields.get("company") and not occurrence.company:
                    self._assign_company(occurrence, fields["company"], fields)
                if (
                    not fields.get("phone")
                    and not fields.get("email")
                    and not self.session.scalar(
                        select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)
                    )
                ):
                    self.session.add(
                        ReviewItem(
                            ad_id=occurrence.id, reason="incomplete contact fields"
                        )
                    )
        self.session.commit()

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
