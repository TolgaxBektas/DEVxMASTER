export type SettingsRepository = {
  get(tenantId: string, key: string): Promise<string | null>;
  set(tenantId: string, key: string, value: string): Promise<void>;
};

export type SettingDefinition<T> = {
  key: string;
  defaultValue: T;
  parse?: (value: string) => T;
  serialize?: (value: T) => string;
};

export function createSettingsService(repository: SettingsRepository) {
  return {
    async get<T>(
      tenantId: string,
      definition: SettingDefinition<T>,
    ): Promise<T> {
      const raw = await repository.get(tenantId, definition.key);
      if (raw === null) return definition.defaultValue;
      return definition.parse ? definition.parse(raw) : (JSON.parse(raw) as T);
    },
    async set<T>(tenantId: string, definition: SettingDefinition<T>, value: T) {
      const raw = definition.serialize
        ? definition.serialize(value)
        : JSON.stringify(value);
      await repository.set(tenantId, definition.key, raw);
    },
  };
}
