/**
 * The ORDER editor — the one admin screen that is not the uniform
 * `edit.php → save.php` machine, and the one place where an order's stock
 * actually comes back.
 *
 * Three facts, all measured live on a test store, decide
 * every function in here:
 *
 *  1. **`action=edit` is mandatory.** `edit.php?id=N&handler=443` without it
 *     answers 200 and renders a BLANK «Новый заказ» form — and materialises an
 *     empty 0.00 row in the orders grid. That is how an earlier probe once mistook a
 *     draft for an order and littered the grid. Every URL built here carries it.
 *  2. **The admin record id is NOT the order number.** They are two independent
 *     autoincrements (draft rows eat admin ids without creating orders): on the
 *     test store API order #7 lived at admin id 9. The only bridge is the editor's
 *     own heading, `Редактирование заказа #7`.
 *  3. **`changeStatus` is the record id, not a constant.** The 80-wave report
 *     called it "constant 2"; that was a coincidence with a draft's id. Every
 *     status form on the page carries `changeStatus=<this record's id>`.
 */
import { CHECKCODE } from "./form.js";

/** Entity-type id of the orders grid/editor in the legacy admin. */
export const ORDER_HANDLER = 443;

/** Statuses the editor's switcher renders (the API also knows 8 «Оплачен»). */
export const ORDER_STATUS_CANCELLED = 4;

/** The editor URL — always with `action=edit` (see fact 1 above). */
export function orderEditPath(adminId: string | number): string {
  return `/adminLegacy/edit.php?id=${encodeURIComponent(String(adminId))}&action=edit&handler=${ORDER_HANDLER}&checkcode=${CHECKCODE}`;
}

/** The "remove the grid row" URL (step B of a delete — it does NOT return stock). */
export function orderDeleteRowPath(adminId: string | number): string {
  return `/adminLegacy/edit.php?del=1&handler=${ORDER_HANDLER}&id=${encodeURIComponent(String(adminId))}&checkcode=${CHECKCODE}`;
}

/**
 * Delivery-note print URL. Pure GET, and it cannot create anything — it only
 * renders an already-existing waybill (measured: with no Nova Poshta credentials
 * it answers «Дані авторизації не заповнені», never a new TTN). `format` is
 * mandatory: without it the endpoint answers HTTP 400.
 */
export function orderPrintPath(format: string, adminIds: Array<string | number>): string {
  const p = new URLSearchParams({ format });
  for (const id of adminIds) p.append("orderIds[]", String(id));
  return `/adminOrder/printDeliveryTN?${p.toString()}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function text(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export interface OrderStatusButton {
  /** The numeric status this button posts. */
  status: number;
  /** Button text as the admin renders it. */
  label: string;
  /** `title` attribute — NOT always the label (status 6 reads «Отправлен»/«Доставляется»). */
  title: string;
  active: boolean;
  /** True for the «Отменен» form, the only one carrying `return_quantity`. */
  hasReturnQuantity: boolean;
}

export interface OrderCartLine {
  hash: string | null;
  article: string;
  articleForDisplay: string;
  title: string;
  price: string;
  quantity: string;
  sum: string;
}

export interface ParsedOrderEditor {
  /** `#N` out of the heading — the number `orders/get` reports. Null on a draft. */
  apiOrderId: number | null;
  heading: string;
  /** True when the page rendered «Новый заказ» — i.e. this id is not an order. */
  isDraft: boolean;
  configPresetName: string | null;
  userId: string | null;
  statuses: OrderStatusButton[];
  activeStatus: OrderStatusButton | null;
  recipient: Record<string, string>;
  managerComment: string;
  customerComment: string;
  delivery: { type: { value: string; label: string } | null; options: Array<{ value: string; label: string }>; method: Record<string, string> };
  payment: { type: { value: string; label: string } | null; payed: { value: string; label: string } | null };
  cart: { lines: OrderCartLine[]; totals: Record<string, string> };
  /** Every named input/textarea value on the page, for anything not modelled above. */
  fields: Record<string, string>;
}

function parseSelect(html: string, name: string): { value: string; label: string } | null {
  const sel = selectBlock(html, name);
  if (!sel) return null;
  const chosen = /<option([^>]*\bselected\b[^>]*)>([\s\S]*?)<\/option>/i.exec(sel);
  const opt = chosen ?? /<option([^>]*)>([\s\S]*?)<\/option>/i.exec(sel);
  if (!opt) return null;
  return { value: /value=["']?([^"'\s>]*)/.exec(opt[1])?.[1] ?? "", label: text(opt[2]) };
}

function selectBlock(html: string, name: string): string | null {
  const re = new RegExp(`<select[^>]*name=["']${name.replace(/[[\]]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)</select>`, "i");
  return re.exec(html)?.[1] ?? null;
}

function parseOptions(html: string, name: string): Array<{ value: string; label: string }> {
  const sel = selectBlock(html, name);
  if (!sel) return [];
  return [...sel.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)].map((m) => ({
    value: /value=["']?([^"'\s>]*)/.exec(m[1])?.[1] ?? "",
    label: text(m[2]),
  }));
}

/**
 * Parse the live order editor. Deliberately its OWN parser: `parseEditForm` is
 * built for the save.php machine (it wants `names[…]` fields, a handlertable and
 * a save action) and the order editor has none of those — it posts to
 * `/order/submit/` and keeps its values in `Recipient[…]` / `Delivery[…]` /
 * `AdminPayment[…]` namespaces.
 */
export function parseOrderEditor(html: string): ParsedOrderEditor {
  const heading = text(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "");
  const numbered = /#\s*(\d+)/.exec(heading);
  const apiOrderId = numbered ? Number(numbered[1]) : null;

  // Every named value on the page. Inputs first, then textareas (their value is
  // the element body, not an attribute).
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = m[1];
    const name = /name=["']?([^"'\s>]+)/.exec(attrs)?.[1];
    if (!name) continue;
    const type = /type=["']?([\w-]+)/.exec(attrs)?.[1]?.toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (!/\bchecked\b/i.test(attrs)) continue;
    }
    fields[name] = decodeEntities(/value=["']([^"']*)["']/.exec(attrs)?.[1] ?? "");
  }
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = /name=["']?([^"'\s>]+)/.exec(m[1])?.[1];
    if (name) fields[name] = decodeEntities(m[2]).trim();
  }

  // Status switcher: one <form> per status, each carrying changeStatus + status.
  const statuses: OrderStatusButton[] = [];
  for (const f of html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/gi)) {
    const body = f[1];
    if (!/status-button/.test(body)) continue;
    const status = Number(/name=["']?status["']?\s+value=["']?(\d+)/i.exec(body)?.[1] ?? NaN);
    if (!Number.isFinite(status)) continue;
    // The «Отменен» button carries a multi-line onClick full of `=>` arrows, so
    // `<a[^>]*>` stops at the first `>` INSIDE the handler and swallowed the JS
    // as the button's label. Take the whole <a>…</a>, cut at the LAST `>` before
    // the closing tag (the label itself is plain text), and read attributes only
    // from the part before the first inline handler.
    const chunk = /<a\b[\s\S]*?<\/a>/i.exec(body)?.[0] ?? "";
    const inner = chunk.replace(/<\/a>\s*$/i, "");
    const gt = inner.lastIndexOf(">");
    const openTag = gt >= 0 ? inner.slice(0, gt) : inner;
    const attrs = openTag.split(/\son[a-z]+\s*=/i)[0];
    if (!/status-button/.test(openTag)) continue;
    statuses.push({
      status,
      label: gt >= 0 ? text(inner.slice(gt + 1)) : "",
      title: decodeEntities(/title=["']([^"']*)["']/.exec(attrs)?.[1] ?? ""),
      active: /class=["'][^"']*\bactive\b/.test(attrs),
      hasReturnQuantity: /name=['"]?return_quantity/.test(body),
    });
  }

  // Label/value rows of the two-column info tables. Rows whose value cell holds
  // no form control are read-only facts (the buyer's own comment is one).
  let customerComment = "";
  for (const r of html.matchAll(
    /<td class=["']td1 border["']>([\s\S]*?)<\/td>\s*<td class=["']td2 border["'][^>]*>([\s\S]*?)<\/td>/gi,
  )) {
    const label = text(r[1]);
    if (/<(input|textarea|select)\b/i.test(r[2])) continue;
    // ru «Комментарий пользователя» / ua «Коментар користувача»
    if (/^(Комментарий пользователя|Коментар користувача)/i.test(label)) customerComment = text(r[2]);
  }

  const method: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    const m = /^Delivery\[delivery_method\]\[(.+)\]$/.exec(name);
    if (m) method[m[1]] = value;
  }

  const lines: OrderCartLine[] = [];
  for (const row of html.matchAll(/<tr[^>]*class=["'][^"']*j-cart-product[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
    const body = row[1];
    const cells = [...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    const hash = /id=["']product_([^"']+)["']/.exec(row[0])?.[1] ?? null;
    const qty = /class=["'][^"']*j-quantity-p[^"']*["'][^>]*value=["']([^"']*)["']/.exec(body)
      ?? /value=["']([^"']*)["'][^>]*class=["'][^"']*j-quantity-p/.exec(body);
    lines.push({
      hash,
      article: text(cells[1] ?? ""),
      articleForDisplay: text(cells[2] ?? ""),
      title: text(cells[3] ?? ""),
      price: text(cells[4] ?? ""),
      quantity: qty?.[1] ?? text(cells[5] ?? ""),
      sum: text(/<span[^>]*class=["'][^"']*j-sum-p[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(cells[6] ?? "")?.[1] ?? cells[6] ?? ""),
    });
  }

  // `(?![-\w])` matters: the delivery row is wrapped in a <tr class=
  // "j-delivery-price-container">, so a plain substring match hit the WRAPPER
  // first and read the whitespace after it as the price (both totals came back
  // empty). Match the class as a whole token.
  const byClass = (cls: string): string =>
    text(new RegExp(`class=["'][^"']*\\b${cls}(?![-\\w])[^"']*["'][^>]*>([\\s\\S]*?)<`, "i").exec(html)?.[1] ?? "");
  const totals: Record<string, string> = {
    quantity: byClass("j-total-quantity"),
    delivery: byClass("j-delivery-price"),
    paymentFee: byClass("j-payment-price"),
  };
  // «Итого» is the last <tfoot> row and has no class of its own.
  const foot = /<tfoot>([\s\S]*?)<\/tfoot>/i.exec(html)?.[1] ?? "";
  const footRows = [...foot.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const last = footRows[footRows.length - 1]?.[1] ?? "";
  const lastCells = [...last.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => text(c[1]));
  if (lastCells.length >= 2) totals.total = lastCells[lastCells.length - 1];

  const recipient: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    const m = /^Recipient\[(.+)\]$/.exec(name);
    if (m && m[1] !== "admin_comment") recipient[m[1]] = value;
  }

  return {
    apiOrderId,
    heading,
    isDraft: apiOrderId === null,
    configPresetName: fields.configPresetName ?? null,
    userId: fields.userId ?? null,
    statuses,
    activeStatus: statuses.find((s) => s.active) ?? null,
    recipient,
    managerComment: fields["Recipient[admin_comment]"] ?? "",
    customerComment,
    delivery: {
      type: parseSelect(html, "Delivery[delivery_type]"),
      options: parseOptions(html, "Delivery[delivery_type]"),
      method,
    },
    payment: {
      type: parseSelect(html, "AdminPayment[payment_type]"),
      payed: parseSelect(html, "AdminPayment[payed]"),
    },
    cart: { lines, totals },
    fields,
  };
}

/**
 * Row ids of ONE orders-grid fragment (`dataGridRow_<id>`), ascending.
 *
 * ⚠ One fragment is ONE PAGE. The grid's page/perPage live in the server-side
 * session, so a single `dataGridReload` is the current window and nothing more —
 * reading it as "the orders" is how a 20-of-thousands slice gets mistaken for
 * the whole grid. Callers that need every row use `AdminClient.listRecords`
 * (see `readOrderGrid` in tools/adminOrders.ts), which walks the pager.
 */
export function parseOrderGridIds(html: string): number[] {
  const ids = new Set<number>();
  for (const m of html.matchAll(/dataGridRow_(\d+)/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}

/** The warehouse-transfer form (`lookup.php load=transfer_income`) for one product. */
export interface TransferForm {
  warehouses: Array<{ id: string; title: string; selected: boolean }>;
  /** Per product id: what the form shows as the article, name and current stock. */
  products: Array<{ id: string; article: string; title: string; stock: number }>;
}

export function parseTransferForm(html: string): TransferForm {
  const warehouses = parseOptions(html, "transfer_warehouse").map((o) => ({
    id: o.value,
    title: o.label,
    selected: false,
  }));
  const sel = selectBlock(html, "transfer_warehouse") ?? "";
  const selectedValue = /<option([^>]*\bselected\b[^>]*)>/i.exec(sel);
  const selectedId = selectedValue ? /value=["']?([^"'\s>]*)/.exec(selectedValue[1])?.[1] : undefined;
  for (const w of warehouses) w.selected = w.id === (selectedId ?? warehouses[0]?.id);

  const products: TransferForm["products"] = [];
  for (const row of html.matchAll(/<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)) {
    const id = /name=["']transfer\[(\d+)\]["']/.exec(row[4])?.[1];
    if (!id) continue;
    products.push({
      id,
      article: text(row[1]),
      title: text(row[2]),
      stock: Number(text(row[3]).replace(",", ".")) || 0,
    });
  }
  return { warehouses, products };
}
