# Demo slides (draft content, 7 slides)

Official limit: 7 slides including the title slide. The deck must show the team
name, the team members and the chosen challenge. Everything must be in English.

Numbers are from the data build of 2026-11-14 (data through 2026-11-13, commit
the build with the revised heat source mask). Recheck them if the data is rebuilt.

**Before building the deck**

- [ ] Replace `[PROJECT NAME]`, `[TAGLINE]`, `[TEAM NAME]`, `[MEMBER 1]`, `[MEMBER 2]`, `[WEBSITE URL]`.
- [ ] Slides 4 and 5 need screenshots of the deployed website. The numbers on
      slide 5 must match what the site shows for the same selection.
- [ ] No NASA logo, flag or mission patch anywhere.

---

## Slide 1. Title

**On the slide**

> # [PROJECT NAME]
> [TAGLINE]
>
> Challenge: Harmonization of MODIS and VIIRS Hot Spots
> Team [TEAM NAME]: [MEMBER 1], [MEMBER 2]
> NASA Space Apps Challenge 2026
> [WEBSITE URL]

Tagline options:
- One fire record, 2003 to today.
- Is this month unusual? Now the satellites agree.
- Twenty-four years of fire, on one scale.

**Say**

We are team [TEAM NAME]. We took the challenge on MODIS and VIIRS hot spots, and
we built a burn calendar that makes more than twenty years of satellite fire
data comparable.

---

## Slide 2. The problem

**Headline:** The fire record is split between instruments that cannot be compared

**On the slide**

| | MODIS Aqua | VIIRS |
|---|---|---|
| Since | 2002 | 2012 |
| Pixel | about 1 km | 375 m |

- Smaller pixels see smaller fires, and count one fire as more pixels.
- United States: 55,000 hotspots a year from MODIS, 365,000 from VIIRS. **6.6 times more.**
- S-NPP VIIRS stopped on 2 November 2026. MODIS is near the end of its mission.

Bottom line, large: **Is this month unusual, or is the sensor just more sensitive?**

**Say**

Satellites have watched fires since the early 2000s, but with two different
instruments. The newer one has smaller pixels, so the same fire activity gives a
number that is several times larger. A fire manager who looks at the raw record
cannot tell real change from a change of instrument. And this is urgent: one of
the VIIRS satellites stopped two weeks ago, and MODIS is ending.

---

## Slide 3. Harmonization, before and after

**Headline:** We put every year on one scale

**On the slide**

Left: `figures/usa_before.png`, top panel only. Label: "Raw record: a jump of
3.6 times in 2012".

Right: `figures/usa_after.png`, top panel only. Label: "Harmonized: one
continuous record".

Under the figures, three short steps:

1. Count **active cell-days**: 0.1 degree cells with fire on a given day.
2. In the years when both instruments flew, measure their ratio for each region
   and calendar month.
3. Convert the older record to the VIIRS S-NPP scale.

**Say**

For more than ten years both instruments observed the same places at about the
same time of day. In that overlap we measure how many VIIRS detections
correspond to one MODIS detection, separately for each region and each month,
because the ratio changes with the type of fire. Then we convert the older
record. On the left, the raw data for the United States: the jump in 2012 is the
instrument, not fire. On the right, the same data after harmonization. The grey
band is our uncertainty.

---

## Slide 4. The product: the burn calendar

**Headline:** Select an area. See its fire history.

**On the slide**

Screenshot of the website: map with a selected rectangle and the year-by-month
calendar. Three callouts on the screenshot:

- "Draw an area or pick a region"
- "One row per year, one column per month, 2003 to today"
- "Hatched cells were converted from another instrument"

Footer: Four regions: contiguous United States, Taiwan, Myanmar with Thailand
and Laos, Argentina. CSV download of the calendar and of the hotspots.

**Say**

This is the tool. You select an area, and you get its burn calendar: one row per
year, one column per month, from 2003 to today. Brighter yellow means more fire,
dark blue means less. You see
at once which months are the burning season and which years were the worst. The
hatched cells were converted from another instrument, so you always know what
was observed and what was estimated. Everything can be downloaded as CSV.

---

## Slide 5. Use case: is this month unusual?

**Headline:** This month so far, against the same days in 23 earlier years

**On the slide**

Screenshot of the month-to-date card and the anomaly view. Next to it, two
examples for the contiguous United States:

> **1 to 13 November 2026**
> 4,924 active cell-days
> 2% above the median of the same 13 days
> 11th highest of 24 years

> **February 2026**
> 12,843 active cell-days
> 71% above the February median
> 2nd highest of 24 years

Small note: November 2026 comes from NOAA-20, converted to the same scale.

**Say**

An emergency manager asks one question: is this worse than usual? The month is
not over, so we do not compare thirteen days with a full month. We compare the
first thirteen days of November with the first thirteen days of November in
every earlier year. Right now the United States is close to normal. Last
February was the second highest February in twenty-four years. The November
figure comes from NOAA-20, a different satellite from last month, and the user
does not need to care.

---

## Slide 6. Validation and limits

**Headline:** We tested it on years it had never seen

**On the slide**

Leave-one-year-out cross-validation, MODIS Aqua to VIIRS S-NPP, 2012-2021:

| | Bias | Monthly error | Year ranking |
|---|---|---|---|
| United States, east | +0.2% | 10% | 0.89 |
| United States, west | +1.1% | 21% | **0.46** |
| Myanmar, Thailand, Laos | +0.2% | 12% | **0.79** |
| Argentina | +0.5% | 12% | 0.83 |
| Our target | within 10% | within 30% | at least 0.8 |

Active cell-days. Year ranking is the Spearman correlation of annual totals.

What we do not claim:

- Year ranking is weak in two regions.
- Taiwan has too few fires: one coefficient for all months, very wide range.
- We found 54 S-NPP outage days in the record and excluded them from training.
- Ranges describe regions, not small areas.

**Say**

How do we know it works? We hide one year, learn the conversion from the other
years, predict the hidden year, and compare with what the satellite really saw.
The bias is about one percent or less, and the monthly error is between ten and
twenty-one percent, inside our targets. We also show what does not work. In two
regions the method does not reliably rank years that are close together. Taiwan
has too few fires for a seasonal conversion. Every converted value in the tool
carries its uncertainty range, and all of this is on the methods page.

---

## Slide 7. Impact and next steps

**Headline:** Twenty-four years of fire history stay usable

**On the slide**

Who it helps:

- **Responders**: is this month unusual, for the days observed so far?
- **Land managers**: when is the burning season, which years were worst?
- **Scientists**: coefficients, uncertainty and the original detections, all downloadable.

Built on open NASA data: 40 million FIRMS detections from three instruments.
The whole data set is rebuilt with one command.

Next:

- More regions, then the globe.
- Add NOAA-21.
- Test other conversions where year ranking is weak.

Footer: [WEBSITE URL] · code and methods are open

**Say**

Because NASA FIRMS publishes all three instruments in the same open format, with
years of overlap, the difference between them can be measured directly from the
data. That is what keeps twenty-four years of fire history usable as the old
instruments retire. Next we want to cover more regions, add NOAA-21, and improve
the conversion where the ranking of years is weak. Thank you.
