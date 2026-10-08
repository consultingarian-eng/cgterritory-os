# Running CGTerritory in the UK

CGTerritory was built for US ZIP codes, but nothing about the board itself is American: an "area" is just a shape on the map with an id. In the UK the natural area is the **postcode sector** (`SW1A 1`, `M1 1`, `LS6 3`): small enough for a team to work in a few days, large enough to plan a week around.

This page covers what changes for a UK office. It is practical guidance, **not legal advice**: check the rules that apply to your product and your areas with the local council, and take advice if you're unsure.

## Checklist for a UK copy

1. In `config/territory.json` ([docs/BRANDING.md](BRANDING.md#company-settings)):
   - `"timezone": "Europe/London"` (or set the `APP_TIMEZONE` variable to `Europe/London`; the variable wins)
   - `"countryCodes": ["gb"]` (addresses are then looked up with Nominatim only; the US Census geocoder is skipped)
   - `"areaLabel": "Sector"` (what an area is called on screen)
   - `"regions"`: one entry per boundary file, for example by postcode area (`LS`, `M`, `B`) or by county
   - `"offices"`: each office's address and its `lat`/`lng`, so distances and drive times are worked out
   - `"research": { "region": "England, United Kingdom", "notes": [ … ] }` to point the AI permit research at UK rules (see [Permits](#permits))
2. Load your sectors with `/load-territory` (it knows the UK sources below).
3. Host the database and the app in Europe if you can ([Data protection](#data-protection)).
4. Write your Do-Not-Knock handling down before you load the list.

## Postcode sectors instead of ZIP codes

- **Area ids** are postcode sectors written with a single space: `LS6 3`, `SW1A 1`. The app accepts US ZIPs and UK sectors out of the box (`areaIdPattern` in `config/territory.json`). When an import gives a full postcode (`LS6 3AB`), it's folded down to its sector (`LS6 3`).
- **Postcode districts** (`LS6`) or council **wards** can be used as areas instead, but you have to change `areaIdPattern` to accept their ids, and keep to one kind of id throughout. Ask Claude Code to do it with you, and test an import before loading the real list.
- Wherever the screens or these guides say "ZIP", read "sector".

## Boundaries: where the shapes come from

The map needs one polygon per sector. Your options:

| Source | Licence | What you get |
| --- | --- | --- |
| **[OS Code-Point Open](https://www.ordnancesurvey.co.uk/products/code-point-open)** (Ordnance Survey OpenData), or the **[ONS Postcode Directory](https://geoportal.statistics.gov.uk/)** (ONS Open Geography Portal) | [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) (with Royal Mail and Crown copyright notices; the ONS directory adds terms for some fields, so read its licence page) | A **point** for every postcode, not shapes. Group the postcodes by sector and draw a shape around each group (Voronoi cells, clipped to the coastline and merged per sector; a Voronoi cell is the patch of ground closer to one postcode point than to any other). Good enough to plan by; edges are approximate |
| **Licensed postcode boundaries** (Ordnance Survey's polygon products, or commercial suppliers) | Paid licence; check it allows use in your own app | Exact sector or unit shapes |
| **Council wards** ([ONS Open Geography Portal](https://geoportal.statistics.gov.uk/)) | Open Government Licence | Exact shapes, but wards aren't postcode sectors (see above) |

There is **no ready-made script** for turning postcode points into sector shapes. `/load-territory` has Claude Code write and run that step for you in a scratch folder, then writes one GeoJSON file per region and shows you the result on the map before anything is kept. Because the shapes are generated and approximate, check them before you rely on them (below). Keep the attribution the licence asks for (for Code-Point Open: Ordnance Survey, Royal Mail and National Statistics copyright and database right notices) in your copy's README and on your map's credits.

### Check the shapes

Before you plan by the shapes, open the map and compare a handful of sectors you know against a postcode lookup (Royal Mail's [postcode finder](https://www.royalmail.com/find-a-postcode) or the [ONS Postcode Directory](https://geoportal.statistics.gov.uk/)): pick a few streets near the edge of each, look up their postcodes, and check each street falls inside the right sector's shape. Edges along rivers, railways and parks are where the approximation is roughest. Fix a wrong shape by regenerating it with more postcode points, or by editing the GeoJSON file; then re-run the territory import and bump `DATA_V` ([docs/DATA.md](DATA.md#3-your-list-of-areas)).

**Households per sector:** the Census publishes household counts for small output areas (ONS for England and Wales, National Records of Scotland, NISRA for Northern Ireland). The ONS Postcode Directory gives each postcode its output area, so counts can be added up per sector. This is optional: the drawer simply shows no household figure without it.

## Distances, units and dates

- Distances from your office to an area are shown in **miles**, with a drive-time estimate (straight-line distance × 1.25 road factor at 45 mph, from the territory loader). Overwrite `drive_mins_<office>` with real drive times if you have them.
- Walking routes are measured in **kilometres and metres** (lap length, deadwalk).
- Permit fees are free text, so write them in pounds (`£250 per person`). The automatic permit **difficulty** score reads the first number in the fee, with thresholds of 50, 250 and 1,000; they work the same in pounds.
- **Dates in files you load** (sales sheets especially) should be written `YYYY-MM-DD` (or be real date cells in Google Sheets). British-style text such as `05/08/2026` is read the American way (month first, so 8 May), and `18/08/2026` is not read at all.
- With `"timezone": "Europe/London"`, everything that depends on "today" follows UK time: the Today strip, coverage-mark dates, when a route plan expires (midnight at the end of the day after it was made), the morning sales refresh times, and the nightly backup (after 03:00).

## Geocoding addresses

Addresses (incident and Do-Not-Knock ✕ pins, worked doors sent as text) are turned into map positions by geocoders. The US Census geocoder only covers the US, so a UK copy uses **Nominatim** (OpenStreetMap's geocoder) alone. Its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) allows about one request a second, with a contact address (`GEOCODER_CONTACT`); the app paces itself and remembers every answer, so each address is only looked up once.

UK addresses in OpenStreetMap vary in completeness; a house number may not be found and the pin lands on the street instead, or not at all. Two ways round it:

- Have your field app send each door's **latitude and longitude** with it (see [docs/DATA.md](DATA.md#8-worked-doors-from-your-field-app)); the app then has nothing to look up. Send the door's **postcode in the `zip` field** too (a full postcode such as `LS6 3AB` is filed under its sector `LS6 3`). Without it the board files the door under the sector whose shape contains the point, so with approximate shapes a door near an edge can land in the neighbouring sector.
- Always include the **postcode** in addresses you import; it narrows the search to the right street. In a Do-Not-Knock file the postcode column may be called `zip`, `postcode` or `sector` and may hold the full postcode ([docs/DATA.md](DATA.md#7-do-not-knock-list-and-incidents)).

## Walking routes in the UK

Routes work the same way ([docs/ROUTES.md](ROUTES.md)) over OpenStreetMap's streets and buildings. How complete OpenStreetMap is varies from place to place, so look at a sector's door count in the drawer before you plan by it. Two differences:

- The US property-tax data that counts flats in a building isn't available for the UK, so door counts come from OpenStreetMap alone: usually one door per house. A building OpenStreetMap tags with more than four flats (`building:flats`), or as apartments with three or more storeys, is treated as a block of flats and left out of routes; one tagged as apartments with no storey count is two doors. Converted houses with several flats are often drawn as plain houses, so they count as one door. A terrace drawn as one long building can count as fewer doors than it has houses; check the door counts in the drawer against what you know of the street.
- Main roads (A and B roads tagged primary or secondary) are never handed out as routes in the UK, because there's no business data to tell a house-lined stretch from a high street. They're still walked along to get between streets.

## Permits

The US version tracks town-by-town soliciting permits. In the UK, what you need depends on **what** you're doing and **where**. Use the Permit section of each area to record what applies, and **check with the council**. Pointers to start from:

- **Selling goods door to door.** Selling goods you carry with you can fall under the **Pedlars Act 1871** (a pedlar's certificate from the police) in England, Wales and Northern Ireland. Taking orders for services or subscriptions, with nothing carried to sell, is generally treated differently. Ask the police or the council's licensing team which applies to you.
- **Street trading.** Councils in England and Wales control street trading under the Local Government (Miscellaneous Provisions) Act 1982 (and London under its own Acts), designating streets as licence, consent or prohibited streets. Door-to-door work is not usually street trading, but some councils have their own rules; check.
- **Scotland.** Councils license street traders (and some other activities) under the **Civic Government (Scotland) Act 1982**, and some apply this to door-to-door selling. Ask each council's licensing team.
- **Charity fundraising.** House-to-house collections for charity need a **licence from the council** in England and Wales under the House to House Collections Act 1939 (in London, from the Metropolitan Police or the City of London), unless the charity holds a national exemption order. Charity fundraisers should also follow the Fundraising Regulator's **Code of Fundraising Practice**. Scotland licenses public charitable collections under the Civic Government (Scotland) Act 1982.
- **No Cold Calling Zones.** Many councils' Trading Standards teams run zones where residents have asked not to be cold-called. They're a strong signal to stay away even where not strictly enforceable: record them as a "Needs Permits" or "Big Blocker" status, or an incident, so your teams see them.
- **Consumer law at the door.** Ignoring a resident's request to leave or not to come back is a banned commercial practice under UK consumer protection law, and sales agreed at the door are "off-premises contracts" with a 14-day cancellation right and information you must give (Consumer Contracts Regulations 2013). Your Do-Not-Knock list is how you keep the first promise.

**🤖 Research with AI** can draft an area's permit position from the council's published rules. Set `research.region` to the nation you work in (England, Wales, Scotland or Northern Ireland) and add notes that point it at the right regimes (for example "Check the council's street trading and house-to-house collection licensing pages, and say whether the area is in a No Cold Calling Zone"). Treat the result as a first draft and check it against the council's own pages.

## Data protection

Several things in the app are personal data under the **UK GDPR and the Data Protection Act 2018**: Do-Not-Knock addresses (an address tied to a household's instruction), incident notes about residents, worked-door records (each carries the rep's name and email and the outcome at the door), sale locations, and your users' accounts. You are the controller for your copy.

Practical steps:

- **Have a lawful basis and say so.** Keeping a Do-Not-Knock list so you respect people's wishes is typically done under legitimate interests; write down a short legitimate interests assessment. Tell your reps what's recorded about their work, in your staff privacy notice.
- **Record the minimum.** For Do-Not-Knock: the address (or the building for a block), the date, and "do not knock". Leave out names, descriptions of people and opinions. Incident notes are read by everyone with an account: write them as facts.
- **Keep it in the right place.** Pick a European region when you create the database (MongoDB Atlas offers London) and the Railway service (Railway offers an EU region). R2 buckets can be restricted to an EU jurisdiction. If you use the AI features, SendGrid or Google Sheets, those providers may process data outside the UK; check their data-processing terms.
- **Decide how long things are kept.** Out of the box, coverage marks are kept 12 weeks, worked doors about 6 months, and nightly backups 30 days. Do-Not-Knock entries and incidents are kept until someone deletes them: review the list regularly, and remove an entry when you no longer need it.
- **Access.** Only give accounts to people who need them, deactivate leavers the day they go (Manage Users), and use demo accounts for showing the system to anyone else.
- **Requests from residents.** If someone asks what you hold about them, or asks you to delete it, you need to be able to find their address in incidents, Do-Not-Knock and worked doors. Note that deleting someone from Do-Not-Knock means you can no longer honour their request not to be visited; explain that to them.
- **The ICO.** Most organisations that process personal data must pay the [ICO data protection fee](https://ico.org.uk/for-organisations/data-protection-fee/) unless exempt; check whether you're already registered.

The [ICO's guidance](https://ico.org.uk/for-organisations/) covers legitimate interests, retention and subject access in plain language.
