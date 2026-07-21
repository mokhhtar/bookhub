# Product

## Register

brand

## Platform

web

## Users

Students, educators, and avid readers who want to understand a book
quickly and accurately. They arrive mid-task: an assignment is due, a
book club meets tomorrow, or a title has been recommended and they want
to know whether it is worth their time before committing to it. The job
to be done is "give me a real, trustworthy guide to this specific book,
now" — not "entertain me with book content."

Most arrive from search on a specific title, landing on a book page
rather than the homepage. The homepage's job is therefore to explain
what Litheca is to someone who has already seen one page and come
looking for the source, and to let a returning visitor start a new book
immediately.

## Product Purpose

Litheca turns any book into a grounded study guide: a deep summary,
characters, themes, real verified quotes, and a quiz whose every
question is backed by a quote checked against the actual source text.
Success is a reader who finishes on the page with an accurate
understanding they can act on, and who trusts it enough to come back
with the next book.

## Positioning

Every fact on the page is real or absent. Litheca returns nothing rather
than guessing, which is what separates it from the AI summary tools that
will confidently invent a character, an award, or a quote.

## Conversion & proof

- Primary CTA: search a book title and generate its guide. This owns the
  first visual position on the page.
- Secondary CTA: browse the guides already published, for visitors not
  ready to type a title.
- The line a visitor remembers after 10 seconds: Litheca will tell you
  it does not know, rather than make something up.
- Belief ladder: (1) this covers the book I actually care about; (2) what
  it produces is genuinely grounded, not generated prose; (3) it is free
  and needs no account to try; (4) it is worth typing my title in.
- Proof on hand: 20M+ books searchable, quiz quotes verified against
  source text, real published guides visible on the homepage. No
  testimonials or press collected yet.

## Brand Personality

A serious reading room. Quiet, exacting, and confident without
performing confidence. The voice is plain and declarative; it states what
it knows and says nothing where it does not know. Restraint here is
deliberate rather than timid, and it is allowed exactly one bold
gesture per page so the quiet reads as a choice.

## Anti-references

- **"AI slop"** — the owner's own diagnosis of the current homepage: one
  component (the marquee) reused for everything, a single flat type
  scale, one accent color applied everywhere, generic rounded cards.
- **The current shipped look** — Inter, coral `#ff5b4f`, uniform 8px
  radii. The most legible AI-default stack there is.
- **The editorial-magazine lane** — display serif plus italic plus
  ruled separators plus tiny tracked uppercase labels above every
  section. A saturated aesthetic and the trap one tier deeper than
  picking a default font; being a book site is not a license to land in
  it.
- **The cream-and-terracotta "bookish" cliché** — warm beige page,
  amber accent, Garamond. The obvious pull for a book brand, therefore
  the one to reach past.
- **Awwwards-agency maximalism** — glassmorphism, bento tiles, heavy
  squircles, entrance animation on every element. A louder template is
  still a template.

## Design Principles

1. **No data beats wrong data, visibly.** The interface's restraint is
   the product's honesty made visible. Empty sections disappear rather
   than being padded; nothing is invented to fill a layout.
2. **Each section earns its own treatment.** A component is reused
   because the content has the same shape, never because it already
   exists. A ranked list is a rail; a quote is a quote; newest guides
   are not a third rail.
3. **Quiet, with one bold gesture.** Boldness is spent in one place per
   page rather than spread thin. Spread evenly, it stops reading as
   emphasis.
4. **Real books are the imagery.** Covers are the honest visual
   material and proof of coverage at once. Decoration is not a
   substitute for them.
5. **The typography carries the seriousness.** Hierarchy comes from a
   committed scale with real contrast between steps, not from color,
   boxes, or icons.

## Accessibility & Inclusion

Observed practice in the existing codebase, to be preserved rather than
regressed: `prefers-reduced-motion` disables the marquee animations,
duplicated marquee items are hidden from screen readers and keyboard
focus, search inputs carry real labels, and icons are `aria-hidden`
alongside text. Text contrast is held to 4.5:1, enforced by
`impeccable detect` as a build gate. No formal WCAG conformance level
has been committed to yet.
