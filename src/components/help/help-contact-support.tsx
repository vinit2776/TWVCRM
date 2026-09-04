"use client";

import { HelpCircle, Mail, Phone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface HelpContactSupportProps {
  email: string;
  phone?: string;
}

export function HelpContactSupport({ email, phone }: HelpContactSupportProps) {
  return (
    <Card id="contact-support" className="scroll-mt-24 border-primary/20 bg-primary/5">
      <CardContent className="pt-6">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-primary/10 p-3 shrink-0">
            <HelpCircle className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-base">Need More Help?</h3>
            <p className="text-sm text-muted-foreground mt-1">
              If you cannot find the answer you are looking for, reach out to our support team. We are here to help!
            </p>
            <div className="mt-3 flex flex-wrap gap-4">
              <a
                href={`mailto:${email}`}
                className="flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <Mail className="h-4 w-4" />
                {email}
              </a>
              {phone && (
                <a
                  href={`tel:${phone.replace(/\s/g, "")}`}
                  className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <Phone className="h-4 w-4" />
                  {phone}
                </a>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
