# World Cities

How many world cities can you name? Type a city and it lights up on the map as a dot sized by
population. Your score is the combined population of the cities you've named, shown as a
percentage of the population of every city in the game (31,705 places with 15,000+ people,
about 3.9 billion people in total).

Inspired by [cityquiz.io](https://cityquiz.io/).

## Playing

- **Tokyo**: adds the biggest city with that name. Type it again to add the next biggest.
- **Kingston, Jamaica** / **Portland, Maine** / **Paris, TX**: narrow it down by country or state.
- **Every country** in the dropdown adds every city with that name at once; picking a country
  limits guesses to that country.
- Accents, punctuation and common alternate names are accepted (Sao Paulo, Bombay, Cologne, Kiev).
- **Show missed cities** reveals everything you haven't named yet. Progress is saved in your browser.

## Running locally

It's a static site with no build step. Serve the folder and open it:

```bash
python -m http.server 8642
```

## Rebuilding the city data

`data/cities.js` is generated from [GeoNames](https://www.geonames.org/) (CC BY 4.0). To refresh it,
download `cities15000.zip` (unzip it), `admin1CodesASCII.txt` and `countryInfo.txt` from
https://download.geonames.org/export/dump/ into one folder, then:

```bash
python tools/build_cities.py path/to/that/folder data/cities.js
```

## Credits

City data © GeoNames, CC BY 4.0. Country shapes from Natural Earth via
[world-atlas](https://github.com/topojson/world-atlas). Map rendering with [D3](https://d3js.org/).
