import { useRef, useState } from "react";
import { Button, Card, DataTable, EmptyState, Skeleton, useModuleQuery, type ModulePageProps } from "@xmaster-center/ui";

type Row = {
  id: number;
  filename?: string;
  state?: string;
  sha256?: string;
  error?: string | null;
};

type UploadResult = {
  filename: string;
  status: "uploading" | "uploaded" | "deduplicated" | "rejected";
  message?: string;
};

export function IngestionPage({ api }: ModulePageProps) {
  const documents = useModuleQuery<Row[]>(api, "modules.ingestion.documents.list");
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const [message, setMessage] = useState("");
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
    <Card><h2>Dokumente</h2><DataTable rows={documents.data ?? []} columns={[
      { key: "filename", label: "Datei" },
      { key: "state", label: "Zustand" },
      { key: "error", label: "Meldung" },
    ]} /></Card>
  </div>;
}
