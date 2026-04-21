import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout/layout";
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
import DocReview from "@/pages/doc-review";
import Timeline from "@/pages/timeline";
import Drafting from "@/pages/drafting";
import Predictive from "@/pages/predictive";
import IntegrationsPage from "@/pages/integrations";
import News from "@/pages/news";
import FinancialNews from "@/pages/financial-news";
import LeadImport from "@/pages/lead-import";
import DecisionEnginePage from "@/pages/decision-engine";
import DecisionEngineSettings from "@/pages/decision-engine-settings";
import BuyersPage from "@/pages/buyers";
import DocumentTemplatesPage from "@/pages/document-templates";
import TemplateAssignmentsPage from "@/pages/template-assignments";
import WorkflowSettingsPage from "@/pages/workflow-settings";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
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
        <Route path="/security" component={Security} />
        <Route path="/doc-review" component={DocReview} />
        <Route path="/timeline" component={Timeline} />
        <Route path="/drafting" component={Drafting} />
        <Route path="/predictive" component={Predictive} />
        <Route path="/integrations" component={IntegrationsPage} />
        <Route path="/news" component={News} />
        <Route path="/financial-news" component={FinancialNews} />
        <Route path="/lead-import" component={LeadImport} />
        <Route path="/decision-engine" component={DecisionEnginePage} />
        <Route path="/decision-engine/settings" component={DecisionEngineSettings} />
        <Route path="/buyers" component={BuyersPage} />
        <Route path="/document-templates" component={DocumentTemplatesPage} />
        <Route path="/template-assignments" component={TemplateAssignmentsPage} />
        <Route path="/workflow-settings" component={WorkflowSettingsPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
