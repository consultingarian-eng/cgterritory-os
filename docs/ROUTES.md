# Walking routes: how they're made

A leader opens a ZIP (or postcode sector), says how many pairs and solos are going out and how many doors each person should get, drops a **P** where the car will be parked, and taps **⚡ Generate**. A minute later each pair or solo has its own lap: a coloured line on the map, a list of streets in order, a door count, a distance and a time, ready to share to their phone.

This page explains what happens in between, so you can trust the routes, explain them to your team, and know which numbers to change. The code is in `lib/osm.js` (streets and doors), `lib/routegen.js` (the routes themselves, pure maths with no database) and `lib/routes_api.js` (saving plans, caching, permissions).

Throughout, "area" means one ZIP code in the US or one postcode sector in the UK: one shape on your map.

## 1. Streets and doors come from OpenStreetMap

The first time anyone generates routes in an area, the server asks OpenStreetMap (through an **Overpass** server) for everything inside the area's boundary:

- **Streets** of the kinds people walk along: residential streets, living streets, unclassified roads, and tertiary, secondary and primary roads (plus their link roads). Motorways and trunk roads are never fetched as walkable streets.
- **Buildings**, and **address points** (a house number with no building drawn).

The server then turns that into a walkable map of the area:

- Every street is cut into **blocks**: always at a junction, and long straight stretches are cut every 120 m or so, so a long road becomes several blocks.
- Every residential building is attached to the block it fronts, on the **side** of the street it's on. A building more than 70 m from any street isn't counted (it isn't on a walkable street).
- Shops, offices, schools, churches, industrial and other non-homes are left out. Unnumbered small outbuildings (garages and sheds, roughly under 45 m²) are left out where the houses around them are numbered.

### Doors are homes, not buildings

In parts of the US the server also reads public property-tax records (assessor parcels) to count the **homes in each building**: a two-family house is 2 doors, a three-decker 3. The adapters are in `lib/parcels/` and cover the US states the original office worked; anywhere without an adapter (including the whole of the UK) uses OpenStreetMap's own hints, which mostly means one door per building. The drawer says so when counts may run low.

What counts as a door is a field rule, and you can change it:

| Rule | Where | Default |
| --- | --- | --- |
| Buildings with more than this many homes are not knocked at all | `MAX_UNITS` in `lib/routegen.js` | 4 (houses, two-families, three-deckers and four-flats only) |
| A block (corner to corner) that's mostly big buildings is left out whole | `prepare()` in `lib/routegen.js` | on |
| Condo buildings are skipped (US parcel data only) | `UNIT_POLICY_CONDOS` | `skip` (set `count` to include) |
| Apartment buildings with this many units or more are skipped (US parcel data only) | `UNIT_POLICY_APT_SKIP_MIN` | 9 |
| Homes counted one by one up to this number per building (US parcel data only) | `UNIT_CAP` | 6 |
| Vacant, commercial, industrial and garage lots remove any building drawn on them (US parcel data only) | `UNIT_POLICY_SUPPRESS` | on (`off` to disable) |

### Caching

Fetching an area takes from a few seconds to a few minutes, so the result is kept:

- in the server's memory (the 24 most recently used areas),
- in MongoDB (the `osmcaches` collection), with the large street map itself stored in your R2/S3 bucket when that's set up (`graphs/<area>.json.gz`), or inside MongoDB when it isn't.

An area is fetched again only when its map is more than **30 days** old, or when the code's map format changes (`GRAPH_VERSION` in `lib/osm.js`). Until the new map arrives the old one keeps serving, and the rebuild happens in the background, one area at a time. A rebuild that fails waits half an hour before it's tried again. US parcel data is kept for 180 days (`parcelcaches`).

## 2. What's already worked is taken out

Before handing anything out, the generator removes:

| Taken out | How it's judged | For how long |
| --- | --- | --- |
| **Worked doors** synced from your field app | A door pin within 40 m of a block counts against it, and fills the nearest house within 22 m. One side of a block counts as walked once at least 2 of its houses, and at least 30% of them, are pinned: the rest of that side were no-answers, not fresh doors. Pins anywhere inside the boundary count, even if they were filed under another area. | 90 days (`ROTATION_DAYS` in `lib/routes_api.js`) |
| **Coverage marks** drawn with ✏ Mark Off | A block counts as marked off once at least 40 m of stroke (or 40% of the block, if shorter) runs within 35 m of it. A stroke marks the street it runs along, not the side streets it crosses. | 12 weeks (marks are kept 84 days) |
| **Today's other plans** | Every block already in a plan made today in that area. Two plans on the same day never share a block. | Today only (see §6) |
| **Main roads** | Primary, secondary and trunk roads are not anybody's route; they can only be walked along to get somewhere. The exception: where US parcel data says which lots along a main road are businesses, a corner-to-corner block of a main road is handed out when it has at least 2 homes and businesses (shops with flats above count as half) make up no more than 30% of it. With no business data (anywhere without a US parcel adapter, including the UK), main roads are always left out. | Always |
| **Big buildings** | See the table above. | Always |

The drawer shows the result before anyone generates: doors mapped, worked and free.

## 3. Where you meet: the park pin

A plan always starts from where the car will be. Setting the **P** is required: tap **📍 Set where you park**, move the map until the P is on your spot, then **Use this spot**, or use **📍 My location**.

- The meeting point is the **nearest street corner to the P (within about 350 m)** that has a reasonable number of free doors around it. The plan names it: "Meet at Oak St & Elm Rd".
- If nothing free is that close, the generator picks a corner itself. In a fresh area (less than 5% worked) it starts from the outer edge and works inwards, so over the following days the area gets worked edge to edge. In a part-worked area it prefers, among the spots that fill up about as fast as the best one, the one that hugs the edge of what's already been worked, so it doesn't leave islands and strips behind.

## 4. Sharing the streets out

- From the meeting corner a **patch** grows outwards along the streets, nearest blocks first, until it holds the doors the whole team needs (plus about 8% slack).
- The routes then grow **at the same time**, block by neighbouring block, each one leaning towards its own slice of the compass (a pie cut around the car, each slice sized to that route's door target). So the team fans out from the car, and nobody walks through someone else's streets.
- Routes only ever grow across a **shared corner**, so each route is one connected walk. It bends around a main road, a park or a railway rather than jumping over it.
- Routes are handed **whole blocks, corner to corner**. A lap never turns back in the middle of a block.
- **Pockets** (a dead-end group of 5 to 40 free doors hemmed in by the new routes or by worked streets) would never get a plan of their own, so the neighbouring route takes them in when its lap still fits the day, giving up open-edge blocks to make room if it has to.
- **Pairs** get twice the doors of a solo. They walk the lap together and split the houses (one side each, or leapfrogging).

## 5. Each route is a lap

The office rule the generator follows: walk forward with the houses on one side of you; at every corner take the first road on that side that isn't done; at the end of a road turn back; and you finish on the same side of the road you started on, across from the car.

In practice:

- **Every street is walked out along one side and back along the other**, so each block is walked twice, once per side.
- **Side streets and cul-de-sacs are taken as you pass them**, out and back, before carrying on.
- **You cross only at corners.** When a side street opens off the far side of the road, the lap doesn't cross mid-street to do it: it carries on and takes that side street on the way back, when it's on your side. Same blocks, same distance; only the order changes.
- The generator tries the lap both ways (houses on your left, and the mirror image with houses on your right) and keeps the one with the shorter street list, then the one with less empty walking.
- If neither can cover every block (rare, on very tangled street layouts), it falls back to a classic closed circuit with the houses on your right, and the route says so.
- **Deadwalk** is shown on every route: the distance walked with nothing to knock on your side.

### How long a lap may take

Each route's time is worked out from its own distance and doors:

- Walking at 75 m a minute (4.5 km/h, crossings included), plus 10 seconds up the path and back at each house.
- Time at the door from a planning model of a three-lap field day: every door is knocked on lap 1; on laps 2 and 3 the doors that didn't answer are knocked again. Seconds waiting after a knock, the share of doors that answer, and minutes for a pitch, a close and a signup are illustrative defaults (`FIELD` at the top of `lib/routegen.js`), not measurements. Put your own team's numbers in `config/territory.json` under `"routePlanning"`, in the same shape as `FIELD`.
- A lap may take at most **120 minutes** by default (three laps have to fit a working day). Set `ROUTE_LAP_MAX_MIN` (45 to 240) to change it.
- If a lap comes out too long (houses spread thinly), the route gives up its farthest whole blocks until it fits. Fewer doors done properly beats a lap nobody finishes. The plan says when routes ran short and why: the area is nearly worked out, houses are too spread out, or the free streets are scattered.

### The limits on a request

| Setting | Range | Default |
| --- | --- | --- |
| Pairs | 0 to 12 | — |
| Solos | 0 to 24 | — |
| Doors per person | 20 to 400 | 100 |

At least one pair or solo is needed. Generation refuses when the area has fewer than 40 free doors left (or, for a team that needs fewer than 40, fewer than it needs).

## 6. How long a plan lasts

Plans follow the calendar day in the app's time zone:

- **On the day it's made**, a plan holds its blocks: nobody else's plan that day can use them.
- **The next day** it stays on the map, so leaders can mark off from it in the morning, but its blocks are free again. The doors it reached are pinned by then; the ones it didn't reach go back into later plans.
- **At midnight at the end of that next day** it comes off the map.
- Tapping **×** on a plan removes it straight away and frees its streets. Sector leaders can only remove plans they made; admins and clients can remove any.

Generation runs in the background, one plan per area at a time. If someone else is generating in the same area, you're asked to wait a minute. Your plan is saved on the server even if your phone loses signal while it's being made.

## 7. OpenStreetMap and Overpass: fair use

The street data is © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright). The app shows that credit on the Street map.

Overpass servers are run by volunteers and small organisations. The app is built to be a light user:

- An area is fetched **once**, then cached for 30 days. Opening a drawer never maps a new area; only generating routes there does. Opening an area whose map is out of date may queue a background refresh of it.
- After a restart the server warms the areas used in the last 14 days from its own cache, and quietly fetches areas where your teams worked doors in the last 14 days but that have never been mapped, **one at a time, 30 seconds apart**.
- It asks one server at a time. Only if there's no answer after 10 seconds does it ask the next one as well (and takes the first good answer); each request gives up after 90 seconds, and a complete failure is retried once after 5 seconds.
- It sends a `User-Agent` naming your copy (`brand.appName`) with a contact address (`GEOCODER_CONTACT`, or `ADMIN_EMAIL` if that isn't set), as the public servers ask. Set one of them to an address you read; `npm run check` warns when neither is set or the address is a placeholder such as `@example.com`. A server that refuses or is overloaded is skipped for the next one, so one refusal on its own (a `406` or `504` in the log) isn't a fault in your copy.

The public servers are listed in `OVERPASS_URLS` in `lib/osm.js`. If you generate a lot of routes, or work a large territory, **run your own Overpass server or use a paid one**, and put its address in `OVERPASS_URL`: it's always tried first. Check each public server's own usage policy before relying on it (for example [overpass-api.de](https://overpass-api.de/)).

## 8. Trying routes without OpenStreetMap

The sample ships with a **made-up street map** for sample ZIP **01108** (`scripts/lib/street-fixture.js`): a grid of 16 fictional streets ("Alder Sample St", "1st Fixture Ave", …) with about 1,100 numbered houses, some of them three-family. `npm run seed:sample` (and `npm run dev:mem`) stores it in the `osmcaches` collection flagged `fixture`, so it is never refreshed from OpenStreetMap. To try it: open 01108, **Routes**, drop the park pin near the middle of the area (42.08124, -72.5625), and generate. The streets are invented, so they won't line up with the real map underneath. Every other area is mapped from OpenStreetMap the first time routes are generated there.

`test/routegen.test.js` runs the generator on the same map with no database or network.

## 9. Changing the rules safely

- The generator is pure functions (`generate`, `applyExclusions`, `prepare` in `lib/routegen.js`). You can run it against a saved street map without a database or a network, which is the safe way to try a change: `require('./scripts/lib/street-fixture').buildFixtureGraph()` gives you the sample map above.
- After changing how the street map is built in `lib/osm.js`, bump `GRAPH_VERSION` so cached maps rebuild (in the background, one at a time).
- If you change what the routes do, update the ⓘ guide text in `public/js/app.js` (`GUIDES.drawer`, the Routes section), which tells your team in plain words what a route skips and when it comes off the map.
