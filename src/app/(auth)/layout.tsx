import Image from "next/image";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-primary/5 via-background to-accent/5 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Image
            src="/logo.png"
            alt="The WorkVilla"
            width={220}
            height={56}
            priority
          />
          <p className="text-sm text-muted-foreground">
            Coworking Space Management
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
