import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { ExternalLink, Fingerprint, KeyRound, ShieldAlert } from "lucide-react";

/**
 * Launch page for the Attendance Gateway.
 *
 * The gateway is a satellite application, not part of this CRM: its own Vercel
 * project, its own database, and its own user accounts. This page exists so the
 * link has a home in the sidebar and so nobody is surprised by being asked to log
 * in again — it deliberately renders no attendance data, because the CRM has no
 * access to any.
 *
 * Distinct from the CRM's own Attendance module at /attendance, which is
 * unrelated and separately managed.
 *
 * The URL is read at build time from NEXT_PUBLIC_ATTENDANCE_URL. Until that is
 * set in the Vercel project, the page renders an unconfigured state rather than a
 * dead link.
 */
const ATTENDANCE_URL = process.env.NEXT_PUBLIC_ATTENDANCE_URL ?? "";

export default function AttendanceGatewayPage() {
  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "Attendance Gateway" }} />

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Attendance Gateway</h1>
        <p className="text-muted-foreground">
          Employee attendance, leave, permissions and field trips — a separate
          application with its own login.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5" />
            Open the Attendance Gateway
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start gap-3 text-sm">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground">
              It uses <strong>separate credentials</strong> from the CRM. Your CRM
              login will not work there, and accounts are administered inside the
              gateway itself.
            </p>
          </div>

          {ATTENDANCE_URL ? (
            <Button asChild>
              {/* rel="noreferrer" so the gateway never receives a CRM URL as referrer */}
              <a href={ATTENDANCE_URL} target="_blank" rel="noopener noreferrer">
                Open Attendance Gateway
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          ) : (
            <div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">Not configured yet</p>
                <p className="text-muted-foreground">
                  Set <code className="text-xs">NEXT_PUBLIC_ATTENDANCE_URL</code>{" "}
                  in the CRM&apos;s Vercel project once the gateway is deployed.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
