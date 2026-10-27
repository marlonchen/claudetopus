"use strict";

// HTML to readable text (snapshot-format.md, Body): Readability over a
// linkedom document, falling back to the page body without scripts, styles
// and page chrome when Readability finds no article. Block elements become
// paragraphs separated by a blank line; whitespace inside one is collapsed.

const { load } = require("./deps");

const BLOCK = new Set(
  (
    "address article aside blockquote body dd details div dl dt fieldset figcaption figure " +
    "footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table " +
    "tbody td tfoot th thead tr ul"
  ).split(" "),
);
const DROP =
  "script, style, noscript, template, iframe, svg, canvas, object, embed, nav, [role=navigation]";
const CHROME = "header, footer, aside, form";

// Paragraph text of a node.
const blockText = (root) => {
  const paragraphs = [];
  let current = "";
  const flush = () => {
    const text = current.replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    current = "";
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      current += node.textContent;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.localName;
    if (tag === "br") {
      current += " ";
      return;
    }
    const block = BLOCK.has(tag);
    if (block) flush();
    for (const child of node.childNodes) walk(child);
    if (block) flush();
  };
  walk(root);
  flush();
  return paragraphs.join("\n\n");
};

const htmlToText = (html) => {
  const { parseHTML } = load("linkedom");
  const { Readability } = load("@mozilla/readability");

  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll(DROP)) node.remove();
  const article = new Readability(document).parse();
  if (article?.content) {
    const text = blockText(parseHTML(`<html><body>${article.content}</body></html>`).document.body);
    if (text) return text;
  }

  const fallback = parseHTML(html).document;
  for (const node of fallback.querySelectorAll(`${DROP}, ${CHROME}`)) node.remove();
  return fallback.body ? blockText(fallback.body) : "";
};

module.exports = { htmlToText };
