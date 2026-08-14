import { useRef, useState } from "react";
import { Button, Card, EmptyState, Skeleton, useModuleQuery, type ModulePageProps } from "@xmaster-center/ui";

type Row = {
  id: number;
  filename?: string;
  state?: string;
  sha256?: string;
  error?: string | null;
  classification?: Classification | null;
};
type Classification = {
  type: string | null;
  typeSource: "filename" | "pdf-metadata" | "title-page" | "first-pages" | "manual";
  typeConfidence: number | null;
  publicationName: string | null;
  publicationNameSource: "filename" | "pdf-metadata" | "title-page" | "first-pages" | "manual";
  publicationNameConfidence: number | null;
  editionLabel: string | null;
  editionSource: "filename" | "pdf-metadata" | "title-page" | "first-pages" | "manual";
  editionConfidence: number | null;
  periodStartYear: number | null;
  periodEndYear: number | null;
  periodIssue: number | null;
  periodSource: "filename" | "pdf-metadata" | "title-page" | "first-pages" | "manual";
  periodConfidence: number | null;
  regionPlace: string | null;
  regionDistrict: string | null;
  regionState: string | null;
  regionSource: "filename" | "pdf-metadata" | "title-page" | "first-pages" | "manual";
  regionConfidence: number | null;
};

type UploadResult = {
  filename: string;
  status: "uploading" | "uploaded" | "deduplicated" | "rejected";
  message?: string;
};

export function IngestionPage({ api }: ModulePageProps) {
  const [type, setType] = useState("");
  const [regionState, setRegionState] = useState("");
  const [periodYear, setPeriodYear] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ type: "", regionState: "", periodYear: "" });
  const [message, setMessage] = useState("");
  const [touchedFields, setTouchedFields] = useState<Record<number, string[]>>({});
  const filters = {
    ...(appliedFilters.type ? { type: appliedFilters.type } : {}),
    ...(appliedFilters.regionState ? { regionState: appliedFilters.regionState } : {}),
    ...(appliedFilters.periodYear ? { periodYear: Number(appliedFilters.periodYear) } : {}),
  };
  const documents = useModuleQuery<Row[]>(api, "modules.ingestion.documents.list", filters);
  const capabilities = useModuleQuery<{ correct: boolean }>(
    api,
    "modules.ingestion.documents.capabilities",
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  if (documents.isLoading) return <Skeleton />;
  if (documents.error) return <EmptyState title="Dokumente konnten nicht geladen werden" />;

  const upload = (file: File, index: number) => new Promise<void>((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/ingestion/documents/upload");
    request.withCredentials = true;
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setUploads((current) => current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, message: `${Math.round(event.loaded / event.total * 100)} %` } : item,
      ));
    };
    request.onload = () => {
      let body: { filename?: string; deduplicated?: boolean; message?: string } = {};
      try { body = JSON.parse(request.responseText) as typeof body; } catch { /* server returned no JSON */ }
      const failed = request.status < 200 || request.status >= 300;
      setUploads((current) => current.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              status: failed ? "rejected" : body.deduplicated ? "deduplicated" : "uploaded",
              message: failed ? body.message ?? "Upload abgelehnt" : body.deduplicated ? "Bereits vorhanden" : "Aufgenommen",
            }
          : item,
      ));
      resolve();
    };
    request.onerror = () => {
      setUploads((current) => current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, status: "rejected", message: "Upload nicht erreichbar" } : item,
      ));
      resolve();
    };
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setMessage("");
    const selected = Array.from(files).map((file) => ({ filename: file.name, status: "uploading" as const }));
    setUploads(selected);
    await Promise.all(Array.from(files).map((file, index) => upload(file, index)));
    await api.invalidate?.("modules.ingestion.documents.list");
  };

  const correct = async (row: Row, form: HTMLFormElement) => {
    const data = new FormData(form);
    const touched = new Set(touchedFields[row.id] ?? []);
    const values: Record<string, string | number | null> = {};
    const stringFields = ["type", "publicationName", "editionLabel", "regionPlace", "regionDistrict", "regionState"];
    for (const name of stringFields) {
      if (touched.has(name)) {
        const raw = String(data.get(name) ?? "");
        values[name] = raw || null;
      }
    }
    for (const name of ["periodStartYear", "periodEndYear", "periodIssue"]) {
      if (touched.has(name)) {
        const raw = String(data.get(name) ?? "");
        if (raw && !/^\d+$/.test(raw)) {
          setMessage(`${name === "periodIssue" ? "Ausgabennummer" : name === "periodStartYear" ? "Startjahr" : "Endjahr"} muss eine Zahl sein.`);
          return;
        }
        values[name] = raw ? Number(raw) : null;
      }
    }
    if (Object.keys(values).length === 0) {
      setMessage("Keine Änderung vorgenommen.");
      return;
    }
    setMessage("");
    try {
      await api.mutate("modules.ingestion.documents.correct", {
        id: row.id,
        ...values,
      });
      await api.invalidate?.("modules.ingestion.documents.list");
      setTouchedFields((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      setMessage("Korrektur gespeichert.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Korrektur fehlgeschlagen");
    }
  };

  const sourceLabel = (source: Classification["typeSource"], confidence: number | null) =>
    !source
      ? "Quelle: nicht erkannt"
      : source === "manual"
      ? "manuell"
      : `Quelle: ${source}${confidence == null ? "" : ` · ${Math.round(confidence * 100)} %`}`;

  return <div className="stack">
    {message && <div className="form-message">{message}</div>}
    <div className="page-heading">
      <div><div className="eyebrow">INGESTION</div><h1>Dokumente</h1><p>PDF-Dokumente aufnehmen und Verarbeitung verfolgen.</p></div>
      <Button onClick={() => inputRef.current?.click()}>PDFs auswählen</Button>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
    </div>
    {uploads.length > 0 && <Card><h2>Upload-Ergebnisse</h2><div className="stack">
      {uploads.map((upload) => <div className="list-row" key={upload.filename}>
        <strong>{upload.filename}</strong><span>{upload.message ?? (upload.status === "uploading" ? "Wird hochgeladen …" : "")}</span>
      </div>)}
    </div></Card>}
    <Card>
      <h2>Einordnung filtern</h2>
      <div className="form-grid">
        <label>Art
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">Alle Arten</option>
            <option value="kommunales-amtsblatt">Kommunales Amtsblatt</option>
            <option value="stadt-und-gemeindemagazin">Stadt-/Gemeindemagazin</option>
            <option value="bürger-und-seniorenwegweiser">Bürger-/Seniorenwegweiser</option>
            <option value="branchenführer">Branchenführer</option>
            <option value="messekatalog">Messekatalog</option>
          </select>
        </label>
        <label>Bundesland
          <input value={regionState} onChange={(event) => setRegionState(event.target.value)} placeholder="z. B. Hamburg" />
        </label>
        <label>Zeitraum enthält Jahr
          <input value={periodYear} onChange={(event) => setPeriodYear(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="z. B. 2020" />
        </label>
      </div>
      <Button onClick={() => setAppliedFilters({ type, regionState, periodYear })}>Filtern</Button>
    </Card>
    <Card>
      <h2>Dokumente</h2>
      {!documents.data?.length && <p>Keine Dokumente für diese Filter.</p>}
      <div className="stack">
        {documents.data?.map((row) => {
          const value = row.classification;
          return <form className="list-row" key={row.id} onChange={(event) => {
            const name = (event.target as HTMLInputElement | HTMLSelectElement).name;
            if (!name) return;
            setTouchedFields((current) => {
              const fields = current[row.id] ?? [];
              return fields.includes(name)
                ? current
                : { ...current, [row.id]: [...fields, name] };
            });
          }} onSubmit={(event) => { event.preventDefault(); void correct(row, event.currentTarget); }}>
            <div className="proposal-meta">
              <strong>{row.filename}</strong>
              <span>Zustand: {row.state}</span>
              <span>Art: {value?.type ?? "nicht erkannt"} · {value ? sourceLabel(value.typeSource, value.typeConfidence) : "—"}</span>
              <span>Publikation: {value?.publicationName ?? "nicht erkannt"} · {value ? sourceLabel(value.publicationNameSource, value.publicationNameConfidence) : "—"}</span>
              <span>Region: {[value?.regionPlace, value?.regionDistrict, value?.regionState].filter(Boolean).join(" · ") || "nicht erkannt"} · {value ? sourceLabel(value.regionSource, value.regionConfidence) : "—"}</span>
              <span>Zeitraum: {value?.editionLabel ?? (value?.periodStartYear ? `${value.periodStartYear}${value.periodEndYear !== value.periodStartYear ? `/${value.periodEndYear}` : ""}` : "nicht erkannt")} · {value ? sourceLabel(value.periodSource, value.periodConfidence) : "—"}</span>
              {row.error && <span>Fehler: {row.error}</span>}
            </div>
            {value && capabilities.data?.correct && <div className="stack">
              <label>Art
                <select name="type" defaultValue={value.type ?? ""}>
                  <option value="">Nicht erkannt</option>
                  <option value="kommunales-amtsblatt">Kommunales Amtsblatt</option>
                  <option value="stadt-und-gemeindemagazin">Stadt-/Gemeindemagazin</option>
                  <option value="bürger-und-seniorenwegweiser">Bürger-/Seniorenwegweiser</option>
                  <option value="branchenführer">Branchenführer</option>
                  <option value="messekatalog">Messekatalog</option>
                </select>
              </label>
              <label>Publikation<input name="publicationName" defaultValue={value.publicationName ?? ""} /></label>
              <label>Ausgabe<input name="editionLabel" defaultValue={value.editionLabel ?? ""} /></label>
              <div className="form-grid">
                <label>Von<input name="periodStartYear" defaultValue={value.periodStartYear ?? ""} /></label>
                <label>Bis<input name="periodEndYear" defaultValue={value.periodEndYear ?? ""} /></label>
                <label>Ausgabe-Nr.<input name="periodIssue" defaultValue={value.periodIssue ?? ""} /></label>
              </div>
              <div className="form-grid">
                <label>Ort<input name="regionPlace" defaultValue={value.regionPlace ?? ""} /></label>
                <label>Kreis<input name="regionDistrict" defaultValue={value.regionDistrict ?? ""} /></label>
                <label>Bundesland<input name="regionState" defaultValue={value.regionState ?? ""} /></label>
              </div>
              <Button type="submit">Korrektur speichern</Button>
            </div>}
          </form>;
        })}
      </div>
    </Card>
  </div>;
}
