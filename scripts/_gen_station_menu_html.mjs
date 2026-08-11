// Renders the same content as components/restaurant/AllStationsMenu.tsx into a
// standalone HTML file, so the layout can be reviewed without running the app.
// Real data from the live database — no placeholders.
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function env(key) {
  const content = fs.readFileSync('.env.local', 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(key + '='))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}

const prisma = new PrismaClient({ datasources: { db: { url: env('DATABASE_URL') } } })
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmt = (n) => Number(n ?? 0).toLocaleString('en-RW', { maximumFractionDigits: 0 })

const users = await prisma.user.findMany({
  where: { email: { endsWith: '@management.com' } }, select: { id: true },
})
const ids = users.map((u) => u.id)
const restaurant = await prisma.restaurant.findFirst({
  where: { OR: [{ ownerId: { in: ids } }, { managerId: { in: ids } }] },
  select: { id: true, name: true },
})

const branches = await prisma.branch.findMany({
  where: { restaurantId: restaurant.id, isActive: true },
  orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
  select: { id: true, name: true },
})
const dishes = await prisma.dish.findMany({
  where: { restaurantId: restaurant.id, deletedAt: null },
  select: { id: true, name: true, category: true, sellingPrice: true, isActive: true, branchId: true },
})

// Mirrors the component: group by branch, then category, hide empty stations.
const stations = branches.map((branch) => {
  const own = dishes.filter((d) => d.branchId === branch.id && d.isActive)
  const byCategory = new Map()
  for (const d of own) {
    const key = (d.category ?? '').trim() || 'Uncategorised'
    byCategory.set(key, [...(byCategory.get(key) ?? []), d])
  }
  const categories = [...byCategory.entries()]
    .map(([name, list]) => ({ name, dishes: list.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.name === 'Uncategorised' ? 1 : b.name === 'Uncategorised' ? -1 : a.name.localeCompare(b.name)))
  return { id: branch.id, name: branch.name, categories, count: own.length }
}).filter((s) => s.count > 0)

const empty = branches.filter((b) => !stations.some((s) => s.id === b.id)).map((b) => b.name)
const total = stations.reduce((sum, s) => sum + s.count, 0)

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Full Menu — ${esc(restaurant.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#f3f4f6; color:#111827; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size:14px; line-height:1.5; }
  .shell { max-width: 900px; margin: 24px auto; background:#fff; border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.12); overflow:hidden; }
  .head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:16px 20px; border-bottom:1px solid #f3f4f6; }
  .head h1 { margin:0; font-size:18px; font-weight:700; }
  .head p { margin:2px 0 0; font-size:12px; color:#6b7280; }
  .tools { display:flex; gap:8px; align-items:center; }
  .btn { border:1px solid #e5e7eb; background:#fff; border-radius:8px; padding:6px 12px; font-size:12px; font-weight:600; color:#374151; cursor:pointer; text-decoration:none; }
  .btn:hover { background:#f9fafb; }
  input[type=search] { border:1px solid #e5e7eb; border-radius:8px; padding:6px 10px; font-size:12px; outline:none; width:180px; }
  input[type=search]:focus { border-color:#fdba74; }
  .jump { display:flex; gap:8px; overflow-x:auto; padding:10px 20px; border-bottom:1px solid #f3f4f6; }
  .jump a { flex:0 0 auto; border:1px solid #e5e7eb; border-radius:8px; padding:6px 12px; font-size:12px; font-weight:600; color:#4b5563; text-decoration:none; white-space:nowrap; }
  .jump a:hover { background:#f9fafb; }
  .jump a.here { border-color:#fdba74; background:#fff7ed; color:#c2410c; }
  .jump a span { color:#9ca3af; margin-left:6px; }
  .body { padding:16px 20px 28px; }
  section { margin-bottom:30px; scroll-margin-top:12px; }
  .sec-head { display:flex; align-items:baseline; gap:8px; border-bottom:2px solid #f97316; padding-bottom:6px; margin-bottom:12px; }
  .sec-head h2 { margin:0; font-size:16px; font-weight:700; }
  .sec-head .n { font-size:12px; color:#9ca3af; }
  .cat { margin-bottom:16px; }
  .cat h3 { margin:0 0 6px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:#ea580c; }
  ul { list-style:none; margin:0; padding:0; }
  li { display:flex; align-items:baseline; justify-content:space-between; gap:16px; padding:6px 0; border-bottom:1px solid #f3f4f6; }
  li .nm { color:#1f2937; }
  li .pr { font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .note { font-size:12px; color:#9ca3af; border-top:1px solid #f3f4f6; padding-top:14px; }
  .hint { margin:0 auto 14px; max-width:900px; font-size:12px; color:#6b7280; background:#fff7ed; border:1px dashed #fdba74; border-radius:10px; padding:10px 14px; }
  .hidden-row { display:none !important; }
  @media print {
    body { background:#fff; }
    .shell { box-shadow:none; margin:0; max-width:none; }
    .jump, .tools, .hint { display:none; }
  }
</style>
</head>
<body>
<div class="hint">
  Static preview of the <strong>View Menu</strong> page, generated from live data
  (${esc(restaurant.name)}, ${fmt(total)} active items across ${stations.length} stations).
  In the app this opens from the Menu tab and scrolls automatically to the station you were on —
  here the station links do that manually.
</div>

<div class="shell">
  <div class="head">
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn" onclick="history.back()">&larr; Back</button>
      <div>
        <h1>Full Menu</h1>
        <p>Every station in this restaurant · ${fmt(total)} items</p>
      </div>
    </div>
    <div class="tools">
      <input type="search" id="q" placeholder="Search dishes" aria-label="Search dishes">
      <button class="btn" onclick="window.print()">Print</button>
    </div>
  </div>

  <div class="jump">
${stations.map((s, i) => `    <a class="${i === 0 ? 'here' : ''}" href="#s-${esc(s.id)}">${esc(s.name)}<span>${s.count}</span></a>`).join('\n')}
  </div>

  <div class="body">
${stations.map((s) => `    <section id="s-${esc(s.id)}" data-station="${esc(s.name.toLowerCase())}">
      <div class="sec-head"><h2>${esc(s.name)} Menu</h2><span class="n">${s.count} items</span></div>
${s.categories.map((c) => `      <div class="cat" data-cat="${esc(c.name.toLowerCase())}">
        <h3>${esc(c.name)}</h3>
        <ul>
${c.dishes.map((d) => `          <li data-name="${esc(d.name.toLowerCase())}"><span class="nm">${esc(d.name)}</span><span class="pr">${fmt(d.sellingPrice)}</span></li>`).join('\n')}
        </ul>
      </div>`).join('\n')}
    </section>`).join('\n')}
${empty.length ? `    <p class="note">No menu items yet on: ${empty.map(esc).join(', ')}.</p>` : ''}
  </div>
</div>

<script>
  // Same filter behaviour as the component's search box.
  var q = document.getElementById('q');
  q.addEventListener('input', function () {
    var term = q.value.trim().toLowerCase();
    document.querySelectorAll('section').forEach(function (sec) {
      var anyInSection = false;
      sec.querySelectorAll('.cat').forEach(function (cat) {
        var anyInCat = false;
        cat.querySelectorAll('li').forEach(function (li) {
          var match = !term || li.dataset.name.indexOf(term) !== -1 || cat.dataset.cat.indexOf(term) !== -1;
          li.classList.toggle('hidden-row', !match);
          if (match) anyInCat = true;
        });
        cat.classList.toggle('hidden-row', !anyInCat);
        if (anyInCat) anyInSection = true;
      });
      sec.classList.toggle('hidden-row', !anyInSection);
    });
  });
</script>
</body>
</html>
`

const out = 'Full-Menu-Preview.html'
fs.writeFileSync(out, html, 'utf8')
console.log(`wrote ${out}`)
console.log(`restaurant: ${restaurant.name}`)
console.log(`stations:   ${stations.length} (${stations.map((s) => `${s.name}=${s.count}`).join(', ')})`)
console.log(`items:      ${total}`)
if (empty.length) console.log(`empty:      ${empty.join(', ')}`)

await prisma.$disconnect()
