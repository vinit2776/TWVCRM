"use client";

import { Keyboard } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { KeyboardShortcut } from "@/lib/help-content";

interface HelpKeyboardShortcutsProps {
  shortcuts: KeyboardShortcut[];
}

export function HelpKeyboardShortcuts({ shortcuts }: HelpKeyboardShortcutsProps) {
  return (
    <Card id="keyboard-shortcuts" className="scroll-mt-24">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Keyboard className="h-5 w-5 text-primary" />
          Keyboard Shortcuts
        </CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <tbody>
            {shortcuts.map((shortcut, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-2.5 pr-4">
                  <div className="flex gap-1">
                    {shortcut.keys.map((key, ki) => (
                      <kbd
                        key={ki}
                        className="inline-flex items-center justify-center rounded border bg-muted px-2 py-0.5 text-xs font-mono font-medium"
                      >
                        {key}
                      </kbd>
                    ))}
                  </div>
                </td>
                <td className="py-2.5 text-muted-foreground">{shortcut.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
