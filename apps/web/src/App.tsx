import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import type { ClientRouter } from "@xmaster-center/kernel";
import { AppShell, EmptyState, type ModulePageProps } from "@xmaster-center/ui";
import { crmPages, CrmPage } from "@xmaster-center/module-crm/ui";
import { systemPages, SystemPage } from "@xmaster-center/module-system/ui";
import { billingPages, BillingPage } from "@xmaster-center/module-billing/ui";
import { ingestionPages, IngestionPage } from "@xmaster-center/module-ingestion/ui";
import { assistantPages, AssistantPage } from "@xmaster-center/module-assistant/ui";
import { ApiError, logout, moduleApi, sessionRequest } from "./api.js";
import { LoginPage } from "./LoginPage.js";
import { useI18n } from "./i18n.js";

const queryClient = new QueryClient();
const trpc = createTRPCReact<ClientRouter>();
const client = trpc.createClient({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

type Page = {
  id: string;
  title: string;
  path: string;
  permission: string;
  component: unknown;
};
const pages: Page[] = [
  ...systemPages.map(([id, title, path, permission]) => ({
    id,
    title,
    path,
    permission,
    component: SystemPage,
  })),
  ...crmPages.map(([id, title, path, permission]) => ({
    id,
    title,
    path,
    permission,
    component: CrmPage,
  })),
  ...billingPages.map(([id, title, path, permission]) => ({
    id,
    title,
    path,
    permission,
    component: BillingPage,
  })),
  ...ingestionPages.map(([id, title, path, permission]) => ({
    id,
    title,
    path,
    permission,
    component: IngestionPage,
  })),
  ...assistantPages.map(([id, title, path, permission]) => ({
    id,
    title,
    path,
    permission,
    component: AssistantPage,
  })),
];
type NavigationEntry = {
  id: string;
  label: string;
  href: string;
  moduleId: string;
  moduleTitle: string;
};

export function App() {
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppContent />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function AppContent() {
  const [session, setSession] = useState<Awaited<
    ReturnType<typeof sessionRequest>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const { t } = useI18n();
  const [location, navigate] = useLocation();
  useEffect(() => {
    void sessionRequest()
      .then((value) => setSession(value))
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);
  const navigation = useMemo(
    () =>
      session
        ? moduleApi
            .query<NavigationEntry[]>("modules.system.navigation")
            .catch(() => [])
        : Promise.resolve([]),
    [session],
  );
  const [nav, setNav] = useState<NavigationEntry[]>([]);
  useEffect(() => {
    void navigation.then(setNav);
  }, [navigation]);
  if (loading) return <div className="center-message">Laden …</div>;
  if (!session)
    return (
      <LoginPage
        onSuccess={() => {
          void sessionRequest().then(setSession);
        }}
      />
    );
  const apiProps: ModulePageProps = { api: moduleApi, navigate, t };
  const page =
    pages.find((item) => item.path === location) ??
    (location.startsWith("/kunden/")
      ? pages.find((item) => item.id === "crm.customers")
      : undefined);
  return (
    <AppShell
      navigation={nav}
      user={session.user.displayName}
      onLogout={() => {
        void logout().finally(() => setSession(null));
      }}
    >
      {page ? (
        <PageComponent page={page} props={apiProps} />
      ) : (
        <Switch>
          <Route>
            <Redirect to={nav[0]?.href ?? "/system"} />
          </Route>
        </Switch>
      )}
    </AppShell>
  );
}

function PageComponent({
  page,
  props,
}: {
  page: Page;
  props: ModulePageProps;
}) {
  const Component = page.component as (input: ModulePageProps) => ReactElement;
  return <Component {...props} />;
}
