"""Build data/cities.js for World Cities from GeoNames dumps.

Download these from https://download.geonames.org/export/dump/ (CC BY 4.0):
  cities15000.zip (unzip to cities15000.txt), admin1CodesASCII.txt, countryInfo.txt

Usage:
  python tools/build_cities.py <dir with the three files> data/cities.js

Every accepted spelling of a city is stored pre-normalised; js/game.js applies
the same normalise() to whatever the player types, so the two must stay in sync.
"""

import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

# Populated-place codes we skip: sections/neighbourhoods of a bigger city
# (would double count people), localities, and historical/abandoned/destroyed places.
SKIP_CODES = {"PPLX", "PPLL", "PPLH", "PPLQ", "PPLW", "PPLCH"}

COUNTRY_NAME_FIXES = {
    "NL": "Netherlands",
    "PS": "Palestine",
    "TL": "Timor-Leste",
    "VA": "Vatican City",
    "ST": "São Tomé and Príncipe",
    "AX": "Åland Islands",
    "CW": "Curaçao",
    "RE": "Réunion",
    "BL": "Saint Barthélemy",
    "BQ": "Caribbean Netherlands",
}

# Extra spellings players may use after a comma, e.g. "Paris, USA".
COUNTRY_ALIASES = {
    "US": ["USA", "United States of America", "America", "U.S.A.", "U.S."],
    "GB": ["UK", "U.K.", "Great Britain", "Britain"],
    "CZ": ["Czech Republic"],
    "CI": ["Cote d'Ivoire", "Côte d'Ivoire"],
    "CD": ["DRC", "DR Congo", "Congo-Kinshasa", "Zaire"],
    "CG": ["Congo", "Congo-Brazzaville"],
    "KR": ["Korea", "Republic of Korea"],
    "KP": ["DPRK"],
    "MM": ["Burma"],
    "NL": ["Holland", "The Netherlands"],
    "PS": ["Palestinian Territory"],
    "SZ": ["Swaziland"],
    "MK": ["Macedonia"],
    "TR": ["Turkiye", "Türkiye"],
    "CV": ["Cape Verde"],
    "TL": ["East Timor", "Timor Leste"],
    "VA": ["Vatican", "Holy See"],
    "AE": ["UAE", "Emirates"],
    "RU": ["Russian Federation"],
    "VN": ["Viet Nam"],
    "GM": ["The Gambia"],
    "BS": ["The Bahamas"],
    "PH": ["The Philippines"],
    "FM": ["Federated States of Micronesia"],
    "ST": ["Sao Tome and Principe"],
}

SPECIAL_LETTERS = str.maketrans({
    "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "ð": "d",
    "þ": "th", "ı": "i", "ħ": "h", "ŧ": "t", "ŀ": "l", "ƒ": "f",
})
APOSTROPHES = re.compile(r"['’‘ʻʼ`´ʿʾ]")
NON_ALNUM = re.compile(r"[^a-z0-9]+")
TOKEN_SWAPS = {"st": "saint", "ste": "sainte", "mt": "mount", "ft": "fort"}


def normalise(text):
    """Lowercase, strip accents and punctuation. Mirrors normalise() in js/game.js."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(ch for ch in text if not unicodedata.category(ch).startswith("M"))
    text = text.translate(SPECIAL_LETTERS)
    text = APOSTROPHES.sub("", text)
    tokens = NON_ALNUM.sub(" ", text).split()
    return " ".join(TOKEN_SWAPS.get(t, t) for t in tokens)


def is_latin(text):
    return all(not ch.isalpha() or "LATIN" in unicodedata.name(ch, "") for ch in text)


def good_alternate(alt):
    """GeoNames alternates include airport codes and machine transliterations; keep real names."""
    alt = alt.strip()
    letters = [ch for ch in alt if ch.isalpha()]
    if not letters or not is_latin(alt) or any(ch.isdigit() for ch in alt):
        return False
    if not letters[0].isupper():  # lowercase entries are auto-transliterations
        return False
    if alt.isupper() and len(alt) <= 5:  # codes like LON, NYC, CDMX
        return False
    # two-letter alternates ("Pa" for Chongqing) would hijack short guesses
    return 3 <= len(normalise(alt)) <= 40


def read_tsv(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                yield line.rstrip("\n").split("\t")


def main(src_dir, out_path):
    src = Path(src_dir)

    countries = {}
    for row in read_tsv(src / "countryInfo.txt"):
        code, iso3, name, continent = row[0], row[1], row[4].strip(), row[8]
        countries[code] = {
            "name": COUNTRY_NAME_FIXES.get(code, name),
            "continent": continent,
            "keys": {normalise(k) for k in [name, code, iso3, *COUNTRY_ALIASES.get(code, [])]},
        }
    for code, info in countries.items():
        info["keys"].add(normalise(info["name"]))

    admins = {}
    for code, name, ascii_name, _ in read_tsv(src / "admin1CodesASCII.txt"):
        keys = {normalise(name), normalise(ascii_name)}
        country, _, sub = code.partition(".")
        if country == "US":  # postal codes: "Portland, ME"
            keys.add(normalise(sub))
        admins[code] = {"name": name, "keys": keys}

    cities = []
    for row in read_tsv(src / "cities15000.txt"):
        if row[7] in SKIP_CODES or row[8] not in countries:
            continue
        pop = int(row[14] or 0)
        if pop <= 0:
            continue
        name, ascii_name = row[1], row[2]
        keys = {normalise(name), normalise(ascii_name)}
        keys.update(normalise(a) for a in row[3].split(",") if good_alternate(a))
        keys.discard("")
        if not keys:
            continue
        primary = normalise(name) or normalise(ascii_name)
        cities.append({
            "id": int(row[0]),
            "name": name,
            "country": row[8],
            "admin": f"{row[8]}.{row[10]}" if f"{row[8]}.{row[10]}" in admins else None,
            "lat": round(float(row[4]), 3),
            "lon": round(float(row[5]), 3),
            "pop": pop,
            "capital": row[7] == "PPLC",
            # primary key first, the rest sorted for stable output
            "keys": [primary] + sorted(keys - {primary}),
        })

    cities.sort(key=lambda c: (-c["pop"], c["name"]))

    used_countries = sorted({c["country"] for c in cities}, key=lambda k: countries[k]["name"])
    country_index = {code: i for i, code in enumerate(used_countries)}
    used_admins = sorted({c["admin"] for c in cities if c["admin"]})
    admin_index = {code: i for i, code in enumerate(used_admins)}

    data = {
        "source": "GeoNames cities15000 (CC BY 4.0), built " + date.today().isoformat(),
        # [iso2, name, continent, "key|key|..."]
        "countries": [
            [code, countries[code]["name"], countries[code]["continent"], "|".join(sorted(countries[code]["keys"]))]
            for code in used_countries
        ],
        # [name, "key|key|..."]
        "admins": [[admins[code]["name"], "|".join(sorted(admins[code]["keys"]))] for code in used_admins],
        # [geonameid, name, countryIdx, adminIdx (-1 if none), lat, lon, population, isCapital, "key|key|..."]
        "cities": [
            [
                c["id"], c["name"], country_index[c["country"]],
                admin_index[c["admin"]] if c["admin"] else -1,
                c["lat"], c["lon"], c["pop"], 1 if c["capital"] else 0, "|".join(c["keys"]),
            ]
            for c in cities
        ],
    }

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    out.write_text("window.WORLD_CITIES=" + payload + ";\n", encoding="utf-8")
    total = sum(c["pop"] for c in cities)
    print(f"{len(cities)} cities in {len(used_countries)} countries, "
          f"total population {total:,}, {out.stat().st_size / 1e6:.2f} MB -> {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
