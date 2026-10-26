import { BotAvatar } from "./BotAvatar";
import {
  COLOR_IDS,
  COLOR_LABELS,
  EXPRESSION_IDS,
  EXPRESSION_LABELS,
  SHAPE_IDS,
  SHAPE_LABELS,
  randomFace,
  type BotFace,
} from "./face";
import { COLOR_BY_ID } from "./skins";

/**
 * The face picker: the three choices the owner makes when they set a bot up.
 *
 * Every tile draws the face with the OTHER two choices already applied, so
 * the picker shows the face that will actually be built rather than a
 * catalogue of disembodied options.
 */

export interface FacePickerProps {
  value: BotFace;
  onChange: (face: BotFace) => void;
  /** Sizes of the preview and of the tiles. */
  compact?: boolean;
}

export function FacePicker({ value, onChange, compact = false }: FacePickerProps) {
  const preview = compact ? 88 : 128;
  const tile = compact ? 40 : 48;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-5">
        <div className="shrink-0">
          <BotAvatar
            face={value}
            size={preview}
            animated
            label={`Preview of the selected face: ${SHAPE_LABELS[value.shape]}, ${COLOR_LABELS[value.color]}, ${EXPRESSION_LABELS[value.expression]}`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <dl className="text-step--1">
            {[
              ["Body", SHAPE_LABELS[value.shape]],
              ["Colour", COLOR_LABELS[value.color]],
              ["Expression", EXPRESSION_LABELS[value.expression]],
            ].map(([key, text]) => (
              <div
                key={key}
                className="flex items-baseline justify-between gap-4 border-b border-[var(--border-dim)] py-1 last:border-0"
              >
                <dt className="text-[var(--faint)]">{key}</dt>
                <dd className="truncate text-[var(--text-soft)]">{text}</dd>
              </div>
            ))}
          </dl>

          {/* The three fieldsets below are precise but slow: eight bodies by
              twelve colours by sixteen expressions. This is the way out for
              someone who does not want to make three decisions. */}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => onChange(randomFace(Math.random, value))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-step--1 text-[var(--text-soft)] transition-colors hover:border-[var(--border-focus)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span aria-hidden="true" className="text-[var(--accent)]">
                ✦
              </span>
              Surprise me
            </button>
          </div>
        </div>
      </div>

      <fieldset>
        <legend className="mb-2 text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
          Body
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {SHAPE_IDS.map((shape) => {
            const selected = value.shape === shape;
            return (
              <button
                key={shape}
                type="button"
                aria-pressed={selected}
                title={SHAPE_LABELS[shape]}
                aria-label={`Body: ${SHAPE_LABELS[shape]}`}
                onClick={() => onChange({ ...value, shape })}
                className={`overflow-hidden rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  selected
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : "border-[var(--border)] hover:border-[var(--border-focus)]"
                }`}
              >
                <BotAvatar
                  face={{ ...value, shape }}
                  size={tile}
                  label={`${SHAPE_LABELS[shape]} body`}
                />
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
          Colour
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {COLOR_IDS.map((color) => {
            const selected = value.color === color;
            const hex = COLOR_BY_ID.get(color)?.hex ?? "#0a0a0c";
            return (
              <button
                key={color}
                type="button"
                aria-pressed={selected}
                title={COLOR_LABELS[color]}
                aria-label={`Colour: ${COLOR_LABELS[color]}`}
                onClick={() => onChange({ ...value, color })}
                className={`h-7 w-7 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] ${
                  selected
                    ? "border-[var(--accent)] scale-110"
                    : "border-[var(--border)] hover:scale-105"
                }`}
                style={{ background: hex }}
              />
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
          Expression
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {EXPRESSION_IDS.map((expression) => {
            const selected = value.expression === expression;
            return (
              <button
                key={expression}
                type="button"
                aria-pressed={selected}
                title={EXPRESSION_LABELS[expression]}
                aria-label={`Expression: ${EXPRESSION_LABELS[expression]}`}
                onClick={() => onChange({ ...value, expression })}
                className={`overflow-hidden rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  selected
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : "border-[var(--border)] hover:border-[var(--border-focus)]"
                }`}
              >
                <BotAvatar
                  face={{ ...value, expression }}
                  size={tile}
                  label={`${EXPRESSION_LABELS[expression]} expression`}
                />
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
