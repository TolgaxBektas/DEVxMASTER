import { useState } from "react";
import type { Language } from "@xmaster-center/contracts";

const messages: Record<Language, Record<string, string>> = {
  de: {
    login: "Anmelden",
    externalId: "Kennung",
    secret: "PIN oder Passwort",
    submit: "Anmelden",
    welcome: "Willkommen im xMaster Center",
  },
  en: {
    login: "Sign in",
    externalId: "Identifier",
    secret: "PIN or password",
    submit: "Sign in",
    welcome: "Welcome to xMaster Center",
  },
  tr: {
    login: "Giriş",
    externalId: "Kimlik",
    secret: "PIN veya şifre",
    submit: "Giriş",
    welcome: "xMaster Center'a hoş geldiniz",
  },
};

export function useI18n() {
  const [language, setLanguage] = useState<Language>(
    () => (localStorage.getItem("xmc-language") as Language) || "de",
  );
  const changeLanguage = (value: Language) => {
    localStorage.setItem("xmc-language", value);
    setLanguage(value);
  };
  return {
    language,
    changeLanguage,
    t: (key: string) => messages[language][key] ?? key,
  };
}
