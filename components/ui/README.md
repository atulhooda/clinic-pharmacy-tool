# components/ui

The UI kit. It started as a **copy** of Ritu Desk's `components/ui` (desk `origin/main` @ `8bee594`,
copied 2026-10-08), as 06a §1.2 and R4-9 say: one look, one engineer, no dependency. This repo owns
the copy; there is no package or runtime link back to the desk, and changes here are not synced.

What came across: `Badge`, `Banner`, `Button`, `Combobox`, `DataList`, `Dialog` (a confirm dialog),
`EmptyState`, `Field`, `IconButton`, `KpiCard`, `Menu`, `MonoLabel`, `Sheet`, `Skeleton`,
`StatusPill` (rewritten for this app's statuses), `StatusRegion`, `icons`. Desk-only components
(booking, chats, WhatsApp chips) were left behind.

The palette is overridden, not extended (`tailwind.config.ts`): `npm run check:classes` fails on any
colour or size class that is not a token.
