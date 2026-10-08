'use strict';

/**
 * HANA's TIMESTAMP type carries no timezone, and the driver returns native-SQL
 * results as bare 'YYYY-MM-DDTHH:MM:SS[.fff]' strings (no 'Z', no offset). `new
 * Date(...)` on an offset-less date-time string is parsed as LOCAL time per the
 * JS spec — everywhere outside UTC+0 that silently shifts the instant, and the
 * shift compounds on every read-modify-write round trip (the wrong instant gets
 * serialized back via `.toISOString()` and misread the same way next time).
 * Every timestamp this module writes is a UTC ISO string, so treat any value
 * read back that has no explicit offset as UTC too.
 */
function utcDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const s = String(v);
  return new Date(/[Zz]$|[+-]\d\d:\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

module.exports = { utcDate };
