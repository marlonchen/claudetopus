"use strict";

// An API response to snapshot text (snapshot-format.md, Body): one
// `key: value` line per field, nested keys joined with `.`, and a blank line
// between records. Each element of a top-level array that holds an object (or
// of the top-level array itself) is a record of its own, its keys led by the
// array's, so a null or a scalar among the results never merges two of them;
// the other top-level fields form one record before them. Numbers are written
// as the response spelled them. Whitespace in a key or value is collapsed to
// one space, so no line break in the data can start a line or a record.

const oneLine = (text) => String(text).replace(/\s+/gu, " ").trim();

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isRecordList = (value) => Array.isArray(value) && value.some(isObject);

// JSON.parse reads every number as a double, which drops trailing zeros
// (5000.00) and digits past 2^53; the reviver keeps the literal instead.
const parseExact = (text) =>
  JSON.parse(text, (_key, value, context) => (typeof value === "number" ? context.source : value));

// The `key: value` lines of `value` under `key` (null at the top).
const lines = (value, key, out) => {
  const join = (part) => (key === null ? part : `${key}.${part}`);
  if (value && typeof value === "object") {
    const pairs = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);
    if (!pairs.length) out.push(oneLine(`${key ?? ""}: ${Array.isArray(value) ? "[]" : "{}"}`));
    for (const [part, item] of pairs) lines(item, join(oneLine(part)), out);
    return out;
  }
  out.push(oneLine(`${key ?? ""}: ${value === null ? "null" : value}`));
  return out;
};

// The snapshot body of a JSON response, or "" when it is not JSON, not an
// object or array, or holds no field.
const jsonToText = (text) => {
  let data;
  try {
    data = parseExact(text);
  } catch {
    return "";
  }
  if (!data || typeof data !== "object" || (Array.isArray(data) && !data.length)) return "";
  const records = [];
  if (isRecordList(data)) {
    for (const item of data) records.push(lines(item, null, []));
  } else if (Array.isArray(data)) {
    records.push(lines(data, null, []));
  } else {
    const envelope = {};
    const lists = [];
    for (const [key, value] of Object.entries(data)) {
      if (isRecordList(value)) lists.push([oneLine(key), value]);
      else envelope[key] = value;
    }
    records.push(Object.keys(envelope).length ? lines(envelope, null, []) : []);
    for (const [key, list] of lists) {
      for (const item of list) records.push(lines(item, key, []));
    }
  }
  return records
    .filter((record) => record.length)
    .map((record) => record.join("\n"))
    .join("\n\n");
};

// The records of an api snapshot body: the text between blank lines.
const apiRecords = (body) => body.split(/\n[ \t]*\n/);

module.exports = { apiRecords, jsonToText };
