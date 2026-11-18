import type { ReactNode } from "react";
import { Brand } from "./brand";
import { RocketArt } from "./rocket";

export function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-svh lg:grid-cols-[minmax(28rem,3fr)_4fr]">
      <section className="flex flex-col gap-8 p-6 md:p-12">
        <Brand />
        <div className="m-auto w-full max-w-sm space-y-6 py-12">{children}</div>
      </section>
      <aside
        aria-hidden="true"
        className="launch-poster relative m-3 hidden overflow-hidden rounded-lg bg-black lg:block"
      >
        <RocketArt />
      </aside>
    </main>
  );
}
