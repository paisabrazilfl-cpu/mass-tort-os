import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout/layout";
import Dashboard from "@/pages/dashboard";
import Leads from "@/pages/leads";
import LeadIntake from "@/pages/lead-intake";
import LeadDetail from "@/pages/lead-detail";
import Documents from "@/pages/documents";
import Cases from "@/pages/cases";
import CaseNew from "@/pages/case-new";
import CaseDetail from "@/pages/case-detail";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/leads" component={Leads} />
        <Route path="/leads/new" component={LeadIntake} />
        <Route path="/leads/:id" component={LeadDetail} />
        <Route path="/documents" component={Documents} />
        <Route path="/cases" component={Cases} />
        <Route path="/cases/new" component={CaseNew} />
        <Route path="/cases/:id" component={CaseDetail} />
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
