import { useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Card, Input } from "@xmaster-center/ui";
import { login } from "./api.js";
import { useI18n } from "./i18n.js";

export function LoginPage({ onSuccess }: { onSuccess(): void }) {
  const { t, language, changeLanguage } = useI18n();
  const [externalId, setExternalId] = useState("admin");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await login(externalId, secret);
      onSuccess();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Anmeldung fehlgeschlagen",
      );
    }
  };
  return (
    <main className="login-screen">
      <Card className="login-card">
        <div className="login-brand">
          <ShieldCheck size={28} />
          <span>xMaster Center</span>
        </div>
        <h1>{t("welcome")}</h1>
        <p className="muted">
          Die zentrale Arbeitsoberfläche für Mandanten, Kunden und Betrieb.
        </p>
        <form onSubmit={submit} className="login-form">
          <label>
            {t("externalId")}
            <Input
              value={externalId}
              onChange={(event) => setExternalId(event.target.value)}
            />
          </label>
          <label>
            {t("secret")}
            <Input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <Button type="submit">{t("submit")}</Button>
        </form>
        <select
          className="language-select"
          value={language}
          onChange={(event) =>
            changeLanguage(event.target.value as "de" | "en" | "tr")
          }
        >
          <option value="de">Deutsch</option>
          <option value="en">English</option>
          <option value="tr">Türkçe</option>
        </select>
      </Card>
    </main>
  );
}
