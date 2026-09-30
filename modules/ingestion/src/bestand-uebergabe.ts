export type BestandHandoffArguments = {
  tenantId: number;
  ags: string;
  apply: boolean;
};

export type BestandHandoffRow = {
  id: number;
  alreadyHandedOff: boolean;
  alreadyQueued: boolean;
};

export type CategorizedBestandHandoffs = {
  candidates: BestandHandoffRow[];
  alreadyHandedOff: BestandHandoffRow[];
  alreadyQueued: BestandHandoffRow[];
  toEnqueue: BestandHandoffRow[];
};

export function parseBestandHandoffArguments(args: string[]): BestandHandoffArguments {
  let tenantValue: string | undefined;
  let ags: string | undefined;
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--anwenden") {
      apply = true;
      continue;
    }
    if (argument !== "--mandant" && argument !== "--gebiet") {
      throw new Error(`Unbekanntes Argument: ${argument}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(argument === "--mandant"
        ? "Pflichtargument --mandant <id> fehlt."
        : "Pflichtargument --gebiet <AGS> fehlt.");
    }
    index += 1;

    if (argument === "--mandant") {
      if (tenantValue !== undefined) {
        throw new Error("--mandant darf nur einmal angegeben werden.");
      }
      tenantValue = value;
    } else {
      if (ags !== undefined) {
        throw new Error("--gebiet darf nur einmal angegeben werden.");
      }
      ags = value;
    }
  }

  if (tenantValue === undefined) {
    throw new Error("Pflichtargument --mandant <id> fehlt.");
  }
  if (ags === undefined) {
    throw new Error("Pflichtargument --gebiet <AGS> fehlt.");
  }

  const tenantId = Number(tenantValue);
  if (!/^\d+$/.test(tenantValue) || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Die Mandantenkennung muss eine positive Ganzzahl sein.");
  }
  if (!/^\d{5}$/.test(ags)) {
    throw new Error("Die Gebietskennung muss genau fünf Ziffern enthalten.");
  }

  return { tenantId, ags, apply };
}

export function categorizeBestandHandoffs(
  rows: BestandHandoffRow[],
): CategorizedBestandHandoffs {
  const candidates = [...rows].sort((left, right) => left.id - right.id);
  const alreadyHandedOff = candidates.filter((row) => row.alreadyHandedOff);
  const alreadyQueued = candidates.filter(
    (row) => !row.alreadyHandedOff && row.alreadyQueued,
  );
  const toEnqueue = candidates.filter(
    (row) => !row.alreadyHandedOff && !row.alreadyQueued,
  );

  return { candidates, alreadyHandedOff, alreadyQueued, toEnqueue };
}
