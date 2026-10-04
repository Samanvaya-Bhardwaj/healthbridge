import { Link } from 'react-router';
import { Building2, Video } from 'lucide-react';
import {
  DAY_MS,
  KIND_STYLES,
  WEEKDAY_SHORT,
  dayBlocks,
  isoWeekday,
  localIso,
} from './weekModel.js';

const PX_PER_MIN = 0.9;

export function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-text-muted" aria-label="Legend">
      {[
        ['available', 'Available: open for booking'],
        ['booked', 'Booked'],
        ['blocked', 'Blocked: held while the patient pays'],
        ['timeOff', 'Time off'],
      ].map(([kind, label]) => (
        <li key={kind} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-3.5 w-5 rounded ${KIND_STYLES[kind]}`}
          />
          {label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Week time grid: published hours (available), appointments (booked), payment holds
 * (blocked) and time off. Read-only: it shows what patients can book and what is taken.
 */
export function WeekGrid({ weekStart, rules = [], appointments = [], timeOff = [] }) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS));
  const perDay = days.map((d) => dayBlocks(d, { rules, appointments, timeOff }));
  const spans = perDay.flat().filter((b) => b.kind !== 'timeOff' || b.end - b.start < 24 * 60);
  const first = Math.min(8 * 60, ...spans.map((b) => b.start));
  const last = Math.max(18 * 60, ...spans.map((b) => b.end));
  const startHour = Math.floor(first / 60);
  const endHour = Math.min(24, Math.ceil(last / 60));
  const height = (endHour - startHour) * 60 * PX_PER_MIN;
  const top = (min) => (Math.max(min, startHour * 60) - startHour * 60) * PX_PER_MIN;
  const today = localIso(new Date());

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[44rem] grid-cols-[3rem_repeat(7,minmax(0,1fr))]">
        <div />
        {days.map((d) => (
          <div
            key={localIso(d)}
            className={`border-b border-border px-1 pb-2 text-center text-xs ${
              localIso(d) === today ? 'font-semibold text-primary' : 'text-text-muted'
            }`}
          >
            {WEEKDAY_SHORT[isoWeekday(d) - 1]}
            <span className="block text-base text-text">{d.getDate()}</span>
          </div>
        ))}
        <div className="relative" style={{ height }}>
          {Array.from({ length: endHour - startHour }, (_, i) => (
            <span
              key={i}
              className="absolute right-1 -translate-y-1/2 text-[10px] text-text-subtle"
              style={{ top: i * 60 * PX_PER_MIN }}
            >
              {String(startHour + i).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        {days.map((d, i) => (
          <div
            key={localIso(d)}
            className="relative border-l border-border"
            style={{
              height,
              backgroundImage: `repeating-linear-gradient(to bottom, var(--hb-border) 0 1px, transparent 1px ${60 * PX_PER_MIN}px)`,
            }}
          >
            {perDay[i]
              .sort(
                (a, b) =>
                  ['timeOff', 'available', 'blocked', 'booked'].indexOf(a.kind) -
                  ['timeOff', 'available', 'blocked', 'booked'].indexOf(b.kind),
              )
              .map((b) => {
                const style = {
                  top: top(b.start),
                  height: Math.max(14, (b.end - Math.max(b.start, startHour * 60)) * PX_PER_MIN),
                };
                const inset =
                  b.kind === 'available' || b.kind === 'timeOff'
                    ? 'inset-x-0.5'
                    : 'left-3 right-0.5';
                const Icon =
                  b.mode === 'online' ? Video : b.mode === 'in_clinic' ? Building2 : null;
                const body = (
                  <>
                    <span className="flex items-center gap-1 truncate font-medium">
                      {Icon && b.kind === 'available' && (
                        <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
                      )}
                      <span className="truncate">{b.label}</span>
                    </span>
                    {style.height > 30 && (
                      <span className="block truncate opacity-80">{b.detail}</span>
                    )}
                  </>
                );
                const cls = `absolute ${inset} overflow-hidden rounded px-1 py-0.5 text-[11px] leading-tight ${KIND_STYLES[b.kind]}`;
                return b.to ? (
                  <Link
                    key={b.key}
                    to={b.to}
                    className={`${cls} hover:ring-2 hover:ring-primary/40`}
                    style={style}
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={b.key} className={cls} style={style}>
                    {body}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Small-screen alternative to the grid: the same blocks as a list per day. */
export function WeekAgenda({ weekStart, rules = [], appointments = [], timeOff = [] }) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS));
  return (
    <ol className="space-y-3">
      {days.map((d) => {
        const blocks = dayBlocks(d, { rules, appointments, timeOff }).sort(
          (a, b) => a.start - b.start,
        );
        return (
          <li key={localIso(d)} className="rounded-xl border border-border p-3">
            <p className="text-sm font-semibold text-text">
              {new Intl.DateTimeFormat('en-IN', {
                weekday: 'long',
                day: 'numeric',
                month: 'short',
              }).format(d)}
            </p>
            {blocks.length === 0 ? (
              <p className="mt-1 text-sm text-text-subtle">No hours</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {blocks.map((b) => {
                  const content = (
                    <>
                      <span className="font-medium">{b.label}</span>
                      <span className="opacity-80"> · {b.detail}</span>
                    </>
                  );
                  const cls = `block rounded-lg px-2.5 py-1.5 text-sm ${KIND_STYLES[b.kind]}`;
                  return (
                    <li key={b.key}>
                      {b.to ? (
                        <Link to={b.to} className={cls}>
                          {content}
                        </Link>
                      ) : (
                        <span className={cls}>{content}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
