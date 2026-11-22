/**
 * What reviewers say, as classified (spec/src/reviews.md §The place card):
 * the source rating, the short summary, aspect meters, top dishes, price,
 * tags and warnings. Reviews themselves never render — only what was learned
 * from them. Drawn in ink and hairlines: the eight accents stay with lists.
 */
import { type PlaceProfile, vocabLabel } from "@placemarks/domain";
import { DerivedTag } from "../library/TagChip";
import type { PlaceSourceRow } from "./db";

const nf = new Intl.NumberFormat();

export function aspectWord(score: number): string {
  if (score >= 1.25) return "Excellent";
  if (score >= 0.5) return "Good";
  if (score > -0.5) return "Mixed";
  if (score > -1.25) return "Poor";
  return "Bad";
}

export function classifierLabel(id: string): string {
  const [provider, model = ""] = id.split(":");
  if (provider === "anthropic") {
    const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
    if (m?.[1])
      return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
    return model;
  }
  if (provider === "typesafe") return "Jev";
  if (provider === "sample") return "sample data (not real reviews)";
  if (provider === "codex") return model.charAt(0).toUpperCase() + model.slice(1);
  return id;
}

const ASPECT_LABEL: Record<string, string> = {
  food: "Food",
  service: "Service",
  value: "Value",
  ambience: "Atmosphere",
  wait: "Wait",
  cleanliness: "Cleanliness",
};

const PRICE_LABEL: Record<string, string> = {
  cheap: "Inexpensive",
  moderate: "Moderately priced",
  pricey: "Pricey",
  very_expensive: "Very expensive",
};

const PRICE_LEVELS = ["cheap", "moderate", "pricey", "very_expensive"];

function SectionTitle({ children }: { children: string }) {
  return <h3 className="eyebrow">{children}</h3>;
}

function Meter({ label, score, mentions }: { label: string; score: number; mentions: number }) {
  const fill = Math.max(0, Math.min(1, (score + 2) / 4));
  return (
    <div
      className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-sm"
      data-testid="aspect-meter"
    >
      <span className="text-ink/80">{label}</span>
      <span
        className="relative h-2 overflow-hidden rounded-pill border border-ink bg-panel"
        role="img"
        aria-label={`${label}: ${aspectWord(score)}, ${mentions} mentions`}
      >
        <span
          className="absolute inset-y-0 left-0 border-r border-ink bg-blush"
          style={{ width: `${fill * 100}%` }}
        />
      </span>
      <span className="w-24 text-right text-xs text-ink/70">
        {aspectWord(score)} <span className="font-mono text-ink/60">·{mentions}</span>
      </span>
    </div>
  );
}

export function PlaceInsightsPanel({
  source,
  profile,
}: {
  source?: PlaceSourceRow;
  profile?: PlaceProfile;
}) {
  const rated = source?.rating !== undefined ? source : undefined;
  if (!profile) {
    return (
      <section className="mt-4" data-testid="place-insights">
        {rated ? <RatingLine source={rated} /> : null}
        <p className="mt-2 text-xs text-ink/60" data-testid="insights-pending">
          Reviews are downloaded but not classified yet. Run{" "}
          <code className="font-mono">pnpm classify run</code>, then load the data folder in
          Settings.
        </p>
      </section>
    );
  }

  const groups: { title: string; kind: "vibe" | "occasion" | "dietary" }[] = [
    { title: "Atmosphere", kind: "vibe" },
    { title: "Good for", kind: "occasion" },
    { title: "Dietary", kind: "dietary" },
  ];
  const practical: string[] = [];
  const share = (n: number) => profile.usefulCount > 0 && n / profile.usefulCount >= 0.1 && n >= 2;
  if (share(profile.practical.reservationAdvised)) practical.push("Booking advised");
  if (share(profile.practical.cashOnly)) practical.push("Cash only");
  if (profile.practical.medianWaitMinutes !== undefined) {
    practical.push(`Typical wait about ${Math.round(profile.practical.medianWaitMinutes)} min`);
  }

  return (
    <section className="mt-4 space-y-4 border-b border-hairline pb-4" data-testid="place-insights">
      <div>
        <SectionTitle>What people say</SectionTitle>
        {rated ? <RatingLine source={rated} price={profile.price?.signal} /> : null}
        {profile.summary ? (
          <p
            className="mt-1.5 font-body text-sm leading-relaxed text-ink/90"
            data-testid="insights-summary"
          >
            {profile.summary.text}
          </p>
        ) : null}
      </div>

      {profile.warnings.length > 0 ? (
        <ul className="space-y-1" data-testid="insights-warnings">
          {profile.warnings.map((w) => (
            <li
              key={w.flag}
              className="rounded-crisp border border-hairline px-2 py-1 text-xs text-ink/85"
            >
              <span aria-hidden="true">⚠ </span>
              {vocabLabel(w.flag)} reported in {w.mentions} recent reviews
            </li>
          ))}
        </ul>
      ) : null}

      {profile.aspects.length > 0 ? (
        <div className="space-y-1.5" data-testid="insights-aspects">
          {profile.aspects.map((a) => (
            <Meter
              key={a.aspect}
              label={ASPECT_LABEL[a.aspect] ?? a.aspect}
              score={a.score}
              mentions={a.mentions}
            />
          ))}
        </div>
      ) : null}

      {profile.dishes.length > 0 ? (
        <div>
          <SectionTitle>People order</SectionTitle>
          <ul className="mt-1.5 flex flex-wrap gap-1.5" data-testid="insights-dishes">
            {profile.dishes.slice(0, 6).map((d) => (
              <li
                key={d.name}
                className="rounded-crisp bg-tag px-2 py-0.5 font-mono text-[11px] text-tag-text"
                title={`${d.mentions} mentions, ${aspectWord(d.score).toLowerCase()}`}
              >
                {d.name} <span className="text-tag-accent">{d.mentions}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {groups.map(({ title, kind }) => {
        const tags = profile.tags.filter((t) => t.kind === kind);
        if (tags.length === 0) return null;
        return (
          <div key={kind}>
            <SectionTitle>{title}</SectionTitle>
            <p className="mt-1.5 flex flex-wrap gap-1.5" data-testid={`insights-tags-${kind}`}>
              {tags.map((t) => (
                <DerivedTag key={t.tag} tag={t.tag} count={t.mentions} />
              ))}
            </p>
          </div>
        );
      })}

      {practical.length > 0 ? (
        <p className="text-sm text-ink/85" data-testid="insights-practical">
          {practical.join(" · ")}
        </p>
      ) : null}

      <p className="text-[11px] text-ink/60" data-testid="insights-provenance">
        Classified from {nf.format(profile.usefulCount)} of {nf.format(profile.reviewCount)} reviews
        by {profile.classifiers.map(classifierLabel).join(" and ") || "an unknown model"}
        {" · "}
        {new Date(profile.computedAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </p>
    </section>
  );
}

function RatingLine({ source, price }: { source: PlaceSourceRow; price?: string }) {
  const parts: string[] = [];
  if (source.rating !== undefined) {
    parts.push(
      `★ ${source.rating.toFixed(1)}${source.ratingCount !== undefined ? ` (${nf.format(source.ratingCount)})` : ""} on Google`,
    );
  }
  // Google's level 1–4 maps onto the same four words the classifier uses.
  const level = source.priceLevel !== undefined ? PRICE_LEVELS[source.priceLevel - 1] : undefined;
  const signal = level ?? price;
  if (signal) parts.push(PRICE_LABEL[signal] ?? signal);
  return (
    <p className="mt-1 text-sm text-ink/80" data-testid="insights-rating">
      {parts.join(" · ")}
    </p>
  );
}
