import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryCache, QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@workspace/api-client-react";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout/layout";
import { RouteErrorBoundary } from "@/components/layout/route-error-boundary";
import { RequireAuth } from "@/components/auth/require-auth";
import { AdminGate } from "@/components/auth/admin-gate";
import { AuthProvider } from "@/contexts/auth-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { toast } from "@/hooks/use-toast";
import { describeError } from "@/lib/api-fetch";

import LoginPage from "@/pages/login";
import LoginMfaPage from "@/pages/login-mfa";
import RegisterPage from "@/pages/register";
import VerifyEmailPage from "@/pages/verify-email";
import MagicLinkPage from "@/pages/magic-link";
import Dashboard from "@/pages/dashboard";
import Pipeline from "@/pages/pipeline";
import Leads from "@/pages/leads";
import LeadIntake from "@/pages/lead-intake";
import LeadDetail from "@/pages/lead-detail";
import Paralegals from "@/pages/paralegals";
import Documents from "@/pages/documents";
import OcrInbox from "@/pages/ocr-inbox";
import NpiLookup from "@/pages/npi-lookup";
import Cases from "@/pages/cases";
import CaseNew from "@/pages/case-new";
import CaseDetail from "@/pages/case-detail";
import ReviewQueue from "@/pages/review-queue";
import Analytics from "@/pages/analytics";
import Compliance from "@/pages/compliance";
import FormEngine from "@/pages/form-engine";
import Vendors from "@/pages/vendors";
import Security from "@/pages/security";
import FirmSettings from "@/pages/firm-settings";
import Users from "@/pages/users";
import CompanyTeams from "@/pages/company-teams";
import DocReview from "@/pages/doc-review";
import Timeline from "@/pages/timeline";
import Drafting from "@/pages/drafting";
import Predictive from "@/pages/predictive";
import IntegrationsPage from "@/pages/integrations";
import BillingPage from "@/pages/billing";
import News from "@/pages/news";
import FinancialNews from "@/pages/financial-news";
import LeadImport from "@/pages/lead-import";
import DecisionEnginePage from "@/pages/decision-engine";
import DecisionEngineSettings from "@/pages/decision-engine-settings";
import BuyersPage from "@/pages/buyers";
import DocumentTemplatesPage from "@/pages/document-templates";
import TemplateAssignmentsPage from "@/pages/template-assignments";
import WorkflowSettingsPage from "@/pages/workflow-settings";
import WebFormsPage from "@/pages/web-forms";
import JobQueue from "@/pages/job-queue";
import CallsPage from "@/pages/calls";
import DarkRoomPage from "@/pages/dark-room";
import AutomationsPage from "@/pages/automations";
import AutomationDocsPage from "@/pages/automation-docs";
import AutomationEditorPage from "@/pages/automation-editor";
import N8nSetupPage from "@/pages/n8n-setup";
import FormsApiPage from "@/pages/forms-api";
import SelfHealPage from "@/pages/self-heal";
import AdminSnapshotsPage from "@/pages/admin-snapshots";
import CompetitiveIntelPage from "@/pages/competitive-intel";
import UserManualPage from "@/pages/user-manual";
import AdsLibrariesPage from "@/pages/ads-libraries";

// Surface generated-hook ApiErrors as toasts so 4xx/5xx don't fail silently.
// 401s are handled separately by api-fetch's auth-failure callback.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
    mutations: { retry: 0 },
  },
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) return;
      toast({
        title: "Couldn't load data",
        description: describeError(err),
        variant: "destructive",
      });
    },
  }),
  mutationCache: new MutationCache({
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) return;
      toast({
        title: "Action failed",
        description: describeError(err),
        variant: "destructive",
      });
    },
  }),
});

function AuthedRoutes() {
  const [location] = useLocation();
  return (
    <Layout>
      <RouteErrorBoundary resetKey={location}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/pipeline" component={Pipeline} />
          <Route path="/leads" component={Leads} />
          <Route path="/leads/new" component={LeadIntake} />
          <Route path="/leads/:id" component={LeadDetail} />
          <Route path="/paralegals" component={Paralegals} />
          <Route path="/documents" component={Documents} />
          <Route path="/ocr-inbox" component={OcrInbox} />
          <Route path="/npi-lookup" component={NpiLookup} />
          <Route path="/review-queue" component={ReviewQueue} />
          <Route path="/cases" component={Cases} />
          <Route path="/cases/new" component={CaseNew} />
          <Route path="/cases/:id" component={CaseDetail} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/compliance" component={Compliance} />
          <Route path="/form-engine" component={FormEngine} />
          <Route path="/vendors" component={Vendors} />
          <Route path="/security">
            <AdminGate>
              <Security />
            </AdminGate>
          </Route>
          <Route path="/firm-settings" component={FirmSettings} />
          <Route path="/users">
            <AdminGate>
              <Users />
            </AdminGate>
          </Route>
          <Route path="/company-teams">
            <AdminGate>
              <CompanyTeams />
            </AdminGate>
          </Route>
          <Route path="/doc-review" component={DocReview} />
          <Route path="/timeline" component={Timeline} />
          <Route path="/drafting" component={Drafting} />
          <Route path="/predictive" component={Predictive} />
          <Route path="/integrations">
            <AdminGate>
              <IntegrationsPage />
            </AdminGate>
          </Route>
          <Route path="/billing" component={BillingPage} />
          <Route path="/calls" component={CallsPage} />
          <Route path="/news" component={News} />
          <Route path="/financial-news" component={FinancialNews} />
          <Route path="/lead-import" component={LeadImport} />
          <Route path="/decision-engine" component={DecisionEnginePage} />
          <Route path="/decision-engine/settings" component={DecisionEngineSettings} />
          <Route path="/buyers" component={BuyersPage} />
          <Route path="/document-templates" component={DocumentTemplatesPage} />
          <Route path="/template-assignments" component={TemplateAssignmentsPage} />
          <Route path="/workflow-settings" component={WorkflowSettingsPage} />
          <Route path="/web-forms" component={WebFormsPage} />
          <Route path="/job-queue" component={JobQueue} />
          <Route path="/dark-room">
            <AdminGate>
              <DarkRoomPage />
            </AdminGate>
          </Route>
          <Route path="/automations" component={AutomationsPage} />
          <Route path="/automation-docs" component={AutomationDocsPage} />
          <Route path="/n8n-setup" component={N8nSetupPage} />
          <Route path="/forms-api" component={FormsApiPage} />
          <Route path="/self-heal">
            <AdminGate>
              <SelfHealPage />
            </AdminGate>
          </Route>
          <Route path="/admin/snapshots">
            <AdminGate>
              <AdminSnapshotsPage />
            </AdminGate>
          </Route>
          <Route path="/competitive-intel">
            <AdminGate>
              <CompetitiveIntelPage />
            </AdminGate>
          </Route>
          <Route path="/user-manual" component={UserManualPage} />
          <Route path="/ads-libraries" component={AdsLibrariesPage} />
          <Route path="/automations/:id" component={AutomationEditorPage} />
          <Route component={NotFound} />
        </Switch>
      </RouteErrorBoundary>
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/login/mfa" component={LoginMfaPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route path="/auth/magic" component={MagicLinkPage} />
      <Route>
        <RequireAuth>
          <AuthedRoutes />
        </RequireAuth>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
