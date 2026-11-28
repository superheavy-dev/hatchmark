export interface UsStateEntry {
  usps: string;
  fips: string;
  name: string;
  aliases: readonly string[];
}

export const US_STATE_ENTRIES: readonly UsStateEntry[] = [
  { usps: "AK", fips: "02", name: "Alaska", aliases: ["Alas."] },
  { usps: "AL", fips: "01", name: "Alabama", aliases: ["Ala."] },
  { usps: "AR", fips: "05", name: "Arkansas", aliases: ["Ark."] },
  { usps: "AS", fips: "60", name: "American Samoa", aliases: ["Territory of American Samoa"] },
  { usps: "AZ", fips: "04", name: "Arizona", aliases: ["Ariz."] },
  { usps: "CA", fips: "06", name: "California", aliases: ["Calif.", "Cal."] },
  { usps: "CO", fips: "08", name: "Colorado", aliases: ["Colo."] },
  { usps: "CT", fips: "09", name: "Connecticut", aliases: ["Conn."] },
  {
    usps: "DC",
    fips: "11",
    name: "District of Columbia",
    aliases: [
      "Washington, D.C.",
      "Washington DC",
      "Wash. D.C.",
      "D.C.",
      "Washington, District of Columbia",
    ],
  },
  { usps: "DE", fips: "10", name: "Delaware", aliases: ["Del."] },
  { usps: "FL", fips: "12", name: "Florida", aliases: ["Fla."] },
  { usps: "GA", fips: "13", name: "Georgia", aliases: ["Ga."] },
  { usps: "GU", fips: "66", name: "Guam", aliases: [] },
  { usps: "HI", fips: "15", name: "Hawaii", aliases: ["Hawai'i"] },
  { usps: "IA", fips: "19", name: "Iowa", aliases: [] },
  { usps: "ID", fips: "16", name: "Idaho", aliases: [] },
  { usps: "IL", fips: "17", name: "Illinois", aliases: ["Ill."] },
  { usps: "IN", fips: "18", name: "Indiana", aliases: ["Ind."] },
  { usps: "KS", fips: "20", name: "Kansas", aliases: ["Kan.", "Kans."] },
  { usps: "KY", fips: "21", name: "Kentucky", aliases: ["Ky."] },
  { usps: "LA", fips: "22", name: "Louisiana", aliases: ["La."] },
  { usps: "MA", fips: "25", name: "Massachusetts", aliases: ["Mass."] },
  { usps: "MD", fips: "24", name: "Maryland", aliases: ["Md."] },
  { usps: "ME", fips: "23", name: "Maine", aliases: ["Me."] },
  { usps: "MI", fips: "26", name: "Michigan", aliases: ["Mich."] },
  { usps: "MN", fips: "27", name: "Minnesota", aliases: ["Minn."] },
  { usps: "MO", fips: "29", name: "Missouri", aliases: ["Mo."] },
  {
    usps: "MP",
    fips: "69",
    name: "Northern Mariana Islands",
    aliases: ["Commonwealth of the Northern Mariana Islands", "CNMI", "N. Mariana Islands"],
  },
  { usps: "MS", fips: "28", name: "Mississippi", aliases: ["Miss."] },
  { usps: "MT", fips: "30", name: "Montana", aliases: ["Mont."] },
  { usps: "NC", fips: "37", name: "North Carolina", aliases: ["N.C.", "N. Carolina"] },
  { usps: "ND", fips: "38", name: "North Dakota", aliases: ["N.D.", "N. Dak.", "N. Dakota"] },
  { usps: "NE", fips: "31", name: "Nebraska", aliases: ["Neb.", "Nebr."] },
  { usps: "NH", fips: "33", name: "New Hampshire", aliases: ["N.H."] },
  { usps: "NJ", fips: "34", name: "New Jersey", aliases: ["N.J."] },
  { usps: "NM", fips: "35", name: "New Mexico", aliases: ["N.M.", "N. Mex."] },
  { usps: "NV", fips: "32", name: "Nevada", aliases: ["Nev."] },
  { usps: "NY", fips: "36", name: "New York", aliases: ["N.Y.", "New York State"] },
  { usps: "OH", fips: "39", name: "Ohio", aliases: [] },
  { usps: "OK", fips: "40", name: "Oklahoma", aliases: ["Okla."] },
  { usps: "OR", fips: "41", name: "Oregon", aliases: ["Ore.", "Oreg."] },
  { usps: "PA", fips: "42", name: "Pennsylvania", aliases: ["Pa.", "Penn.", "Penna."] },
  { usps: "PR", fips: "72", name: "Puerto Rico", aliases: ["Commonwealth of Puerto Rico", "P.R."] },
  { usps: "RI", fips: "44", name: "Rhode Island", aliases: ["R.I."] },
  { usps: "SC", fips: "45", name: "South Carolina", aliases: ["S.C.", "S. Carolina"] },
  { usps: "SD", fips: "46", name: "South Dakota", aliases: ["S.D.", "S. Dak.", "S. Dakota"] },
  { usps: "TN", fips: "47", name: "Tennessee", aliases: ["Tenn."] },
  { usps: "TX", fips: "48", name: "Texas", aliases: ["Tex."] },
  { usps: "UT", fips: "49", name: "Utah", aliases: [] },
  { usps: "VA", fips: "51", name: "Virginia", aliases: ["Va."] },
  {
    usps: "VI",
    fips: "78",
    name: "U.S. Virgin Islands",
    aliases: [
      "United States Virgin Islands",
      "Virgin Islands of the United States",
      "Virgin Islands",
      "USVI",
    ],
  },
  { usps: "VT", fips: "50", name: "Vermont", aliases: ["Vt."] },
  { usps: "WA", fips: "53", name: "Washington", aliases: ["Wash.", "Washington State"] },
  { usps: "WI", fips: "55", name: "Wisconsin", aliases: ["Wis.", "Wisc."] },
  { usps: "WV", fips: "54", name: "West Virginia", aliases: ["W.Va.", "W. Virginia"] },
  { usps: "WY", fips: "56", name: "Wyoming", aliases: ["Wyo."] },
];

export const US_NOT_DRAWN: readonly string[] = ["AS", "GU", "MP", "VI"];

export const US_AMBIGUOUS: Readonly<Record<string, readonly string[]>> = {
  Carolina: ["NC", "SC"],
  Dakota: ["ND", "SD"],
};
