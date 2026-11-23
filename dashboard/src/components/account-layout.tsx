import type { ReactNode } from "react";
import { Brand } from "./brand";
import { RocketArt } from "./rocket";

export function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-svh lg:grid-cols-[minmax(28rem,3fr)_4fr]">
      <section className="flex min-w-0 flex-col gap-6 p-4 sm:p-6 md:p-12">
        <Brand />
        <div className="mx-auto my-4 w-full max-w-sm space-y-4 sm:my-auto sm:py-8 [&_input]:min-h-10 [&_button[type=submit]]:min-h-10">
          {children}
        </div>
      </section>
      <aside
        aria-hidden="true"
        className="launch-poster relative hidden overflow-hidden border-l bg-black lg:block"
      >
        <RocketArt />
      </aside>
    </main>
  );
}
