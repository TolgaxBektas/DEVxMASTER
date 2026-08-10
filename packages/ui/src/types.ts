import type { ReactNode } from "react";

export type ModuleUiApi = {
  query<T>(path: string, input?: unknown): Promise<T>;
  mutate<T>(path: string, input?: unknown): Promise<T>;
};

export type ModulePageProps = {
  api: ModuleUiApi;
  navigate(path: string): void;
  t(key: string): string;
};

export type TableColumn<T> = {
  key: string;
  label: string;
  render?(row: T): ReactNode;
};
