'use strict';

/** Dates et fuseau horaire de la boutique (Africa/Abidjan, UTC+0, sans DST). */

const TZ = 'Africa/Abidjan';
const LOCALE = 'fr-FR';

function nowIso() {
  return new Date().toISOString();
}

function parse(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 2026-10-14T09:05:00Z -> "14/10/2026 09:05" */
function formatDateTime(value, opts = {}) {
  const d = parse(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: opts.dateStyle || 'short',
    timeStyle: opts.timeStyle || 'short',
    timeZone: TZ,
  }).format(d);
}

function formatDate(value, style = 'medium') {
  const d = parse(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: style, timeZone: TZ }).format(d);
}

function formatTime(value) {
  const d = parse(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(LOCALE, { timeStyle: 'short', timeZone: TZ }).format(d);
}

function formatRelative(value) {
  const d = parse(value);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const units = [
    ['second', 1000],
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
    ['month', 2_592_000_000],
    ['year', 31_536_000_000],
  ];
  let chosen = ['second', Math.round(-diff / 1000)];
  for (const [unit, ms] of units) {
    if (abs < ms * 60 && unit === 'second') continue;
    if (abs >= ms) chosen = [unit, Math.round(-diff / ms)];
  }
  return rtf.format(chosen[1], chosen[0]);
}

/** Date du jour dans le fuseau de la boutique, au format YYYY-MM-DD. */
function todayInTz(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function yearInTz(date = new Date()) {
  return todayInTz(date).slice(0, 4);
}

function addMinutes(date, minutes) {
  return new Date(parse(date).getTime() + minutes * 60_000).toISOString();
}

function addDays(date, days) {
  return new Date(parse(date).getTime() + days * 86_400_000).toISOString();
}

function isPast(value) {
  const d = parse(value);
  return d ? d.getTime() < Date.now() : false;
}

function isFuture(value) {
  const d = parse(value);
  return d ? d.getTime() > Date.now() : false;
}

/** Fenêtre de promotion active ? */
function isWithin(startsAt, endsAt, at = new Date()) {
  const t = at.getTime();
  const s = parse(startsAt);
  const e = parse(endsAt);
  if (s && t < s.getTime()) return false;
  if (e && t > e.getTime()) return false;
  return Boolean(s || e);
}

/** Normalise une saisie de formulaire `date` ou `datetime-local` en ISO UTC. */
function fromInput(value, { endOfDay = false } = {}) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return new Date(`${v}:00Z`).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO -> valeur exploitable par <input type="date">. */
function toDateInput(value) {
  const d = parse(value);
  return d ? d.toISOString().slice(0, 10) : '';
}

function toDateTimeInput(value) {
  const d = parse(value);
  return d ? d.toISOString().slice(0, 16) : '';
}

module.exports = {
  TZ,
  LOCALE,
  nowIso,
  parse,
  formatDateTime,
  formatDate,
  formatTime,
  formatRelative,
  todayInTz,
  yearInTz,
  addMinutes,
  addDays,
  isPast,
  isFuture,
  isWithin,
  fromInput,
  toDateInput,
  toDateTimeInput,
};
