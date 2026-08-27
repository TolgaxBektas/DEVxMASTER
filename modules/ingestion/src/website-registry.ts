import { readFileSync } from "node:fs";

export type AreaWebsite = {
  ags: string;
  level: "kreis" | "gemeinde";
  name: string;
  url: string;
};

type WebsiteRegister = {
  metadata: {
    source: string[];
    queryFiles: string[];
    queriedAt: string;
    generatedAt: string;
  };
  websites: AreaWebsite[];
};

const register = JSON.parse(readFileSync(
  new URL("./data/websites.de.json", import.meta.url),
  "utf8",
)) as WebsiteRegister;

export const MAX_MUNICIPALITY_SEEDS_PER_RUN = 25;

export function areaWebsiteSeeds(
  ags: string,
  municipalityOffset = 0,
): {
  seedPages: string[];
  archiveDomains: string[];
  municipalityCount: number;
  nextMunicipalityOffset: number;
} {
  const websites = register.websites.filter((website) => website.ags === ags);
  const circlePages = websites
    .filter((website) => website.level === "kreis")
    .map((website) => website.url);
  const municipalities = websites.filter((website) => website.level === "gemeinde");
  const start = Math.max(0, Math.floor(municipalityOffset));
  const selected = municipalities.slice(start, start + MAX_MUNICIPALITY_SEEDS_PER_RUN);
  return {
    seedPages: [...circlePages, ...selected.map((website) => website.url)],
    archiveDomains: [...circlePages, ...selected.map((website) => website.url)]
      .map((url) => {
        try {
          return new URL(url).hostname.toLocaleLowerCase("de-DE").replace(/^www\./, "");
        } catch {
          return null;
        }
      })
      .filter((host): host is string => host !== null),
    municipalityCount: selected.length,
    nextMunicipalityOffset: start + selected.length,
  };
}

export function websiteRegister(): WebsiteRegister {
  return register;
}
