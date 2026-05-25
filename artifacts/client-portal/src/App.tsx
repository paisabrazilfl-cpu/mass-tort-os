import { Router, Route, Switch, Redirect } from "wouter";
import { PortalAuthProvider, usePortalAuth } from "./contexts/PortalAuthContext";
import { RequireAuth } from "./components/RequireAuth";
import { PortalLayout } from "./components/PortalLayout";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { MfaSetupPage } from "./pages/MfaSetupPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { RecordsPage } from "./pages/RecordsPage";

// Extract the tort slug from the first path segment: /camp-lejeune/login → "camp-lejeune"
function extractSlug(): string {
  const segments = window.location.pathname.split("/").filter(Boolean);
  return segments[0] || "portal";
}

function PortalRoutes() {
  const { tortSlug, isAuthenticated, me } = usePortalAuth();

  return (
    <Router base={`/${tortSlug}`}>
      <Switch>
        {/* Public routes */}
        <Route path="/login" component={LoginPage} />
        <Route path="/signup" component={SignupPage} />
        <Route path="/verify-email" component={VerifyEmailPage} />

        {/* MFA setup — requires auth but not MFA yet */}
        <Route path="/mfa-setup">
          <RequireAuth requireMfa={false}>
            <MfaSetupPage />
          </RequireAuth>
        </Route>

        {/* Protected routes */}
        <Route path="/dashboard">
          <RequireAuth>
            <PortalLayout>
              <DashboardPage />
            </PortalLayout>
          </RequireAuth>
        </Route>

        <Route path="/documents">
          <RequireAuth>
            <PortalLayout>
              <DocumentsPage />
            </PortalLayout>
          </RequireAuth>
        </Route>

        <Route path="/records">
          <RequireAuth>
            <PortalLayout>
              <RecordsPage />
            </PortalLayout>
          </RequireAuth>
        </Route>

        {/* Default redirect */}
        <Route>
          {isAuthenticated && me?.mfa_enabled
            ? <Redirect to={`/${tortSlug}/dashboard`} />
            : <Redirect to={`/${tortSlug}/login`} />
          }
        </Route>
      </Switch>
    </Router>
  );
}

export default function App() {
  const slug = extractSlug();

  return (
    <PortalAuthProvider tortSlug={slug}>
      <PortalRoutes />
    </PortalAuthProvider>
  );
}
