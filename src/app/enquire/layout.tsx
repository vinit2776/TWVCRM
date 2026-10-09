import { GoogleTagManager } from "@/components/public/gtm";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GoogleTagManager />
      {children}
    </>
  );
}
