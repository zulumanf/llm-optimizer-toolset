/**
 * The market-pack registry (spec 040): five launch cities as reviewable,
 * versioned data. Adding a city = adding an entry here — core logic never
 * changes. Structural validity is enforced by tests/unit/market-packs.test.ts
 * (placeholders known, exclusions exist in the hierarchy, tiers legal).
 */
import type {
  GeoNode,
  MarketPackDefinition,
  MarketPromptTemplate,
} from "@/lib/markets/types";

const USA: Omit<GeoNode, "children"> = {
  name: "United States",
  kind: "country",
  aliases: ["USA", "US"],
};

/** The eleven target prompt categories as standard templates; every pack
 * gets these, plus its own extras. All are recommendation-intent. */
export function standardTemplates(): MarketPromptTemplate[] {
  return [
    {
      key: "best-agents-city",
      text: "Who are the best real estate agents in {city}?",
      category: "recommendation",
      tier: 2,
      audience: "general",
      scope: "city",
    },
    {
      key: "best-teams-city",
      text: "Which real estate teams in {city} have the best track record?",
      category: "recommendation",
      tier: 2,
      audience: "general",
      scope: "city",
    },
    {
      key: "best-listing-agent",
      text: "Who are the best listing agents in {city}?",
      category: "recommendation",
      tier: 1,
      audience: "seller",
      scope: "city",
    },
    {
      key: "sell-property-neighborhood",
      text: "Who should I use to sell a {propertyType} in {area}?",
      category: "recommendation",
      tier: 1,
      audience: "seller",
      scope: "neighborhood",
      expand: "primaryPropertyType",
    },
    {
      key: "best-buyer-agent",
      text: "Who is the best buyer's agent in {city}?",
      category: "recommendation",
      tier: 1,
      audience: "buyer",
      scope: "city",
    },
    {
      key: "luxury-agents",
      text: "Who are the best luxury real estate agents in {city}?",
      category: "recommendation",
      tier: 1,
      audience: "general",
      scope: "city",
    },
    {
      key: "neighborhood-specialist",
      text: "Which real estate agents specialize in {area}?",
      category: "recommendation",
      tier: 1,
      audience: "general",
      scope: "neighborhood",
    },
    {
      key: "property-type-specialist",
      text: "Who are the top {propertyType} specialists in {city}?",
      category: "recommendation",
      tier: 2,
      audience: "general",
      scope: "city",
      expand: "propertyType",
    },
    {
      key: "price-tier-specialist",
      text: "Which {city} real estate agents specialize in {priceTier} properties?",
      category: "recommendation",
      tier: 2,
      audience: "general",
      scope: "city",
      expand: "priceTier",
    },
    {
      key: "relocation",
      text: "I'm relocating to {city} — which realtor should I work with?",
      category: "recommendation",
      tier: 2,
      audience: "buyer",
      scope: "city",
    },
    {
      key: "investor",
      text: "Which {city} real estate agents are best for investment properties?",
      category: "recommendation",
      tier: 2,
      audience: "investor",
      scope: "city",
    },
    {
      key: "international-buyers",
      text: "Which {city} real estate agents work well with international buyers?",
      category: "recommendation",
      tier: 3,
      audience: "buyer",
      scope: "city",
    },
    {
      key: "new-development",
      text: "Who are the best agents for new development condos in {city}?",
      category: "recommendation",
      tier: 2,
      audience: "buyer",
      scope: "city",
    },
  ];
}

const COMMON_PRICE_TIERS = ["entry-level", "mid-market", "luxury", "ultra-luxury"];
const COMMON_BUYER_SEGMENTS = ["first-time", "relocation", "investor", "international"];
const COMMON_SELLER_SEGMENTS = ["move-up", "downsizing", "estate", "investor-exit"];

export const MARKET_PACKS: MarketPackDefinition[] = [
  {
    key: "nyc",
    version: 1,
    cityName: "New York City",
    hierarchy: {
      ...USA,
      children: [
        {
          name: "New York",
          kind: "state",
          aliases: ["NY"],
          children: [
            {
              name: "New York metropolitan area",
              kind: "metro",
              aliases: ["NY metro", "Tri-State area"],
              children: [
                {
                  name: "New York City",
                  kind: "city",
                  aliases: ["NYC", "New York, NY"],
                  children: [
                    {
                      name: "Manhattan",
                      kind: "borough",
                      children: [
                        { name: "Tribeca", kind: "neighborhood", aliases: ["TriBeCa"] },
                        { name: "SoHo", kind: "neighborhood", aliases: ["Soho"] },
                        { name: "Upper East Side", kind: "neighborhood", aliases: ["UES"] },
                        { name: "Upper West Side", kind: "neighborhood", aliases: ["UWS"] },
                        { name: "Chelsea", kind: "neighborhood" },
                        { name: "West Village", kind: "neighborhood" },
                        { name: "Financial District", kind: "neighborhood", aliases: ["FiDi"] },
                        { name: "Harlem", kind: "neighborhood" },
                        { name: "Chinatown", kind: "neighborhood" },
                      ],
                    },
                    {
                      name: "Brooklyn",
                      kind: "borough",
                      children: [
                        { name: "Williamsburg", kind: "neighborhood" },
                        { name: "Park Slope", kind: "neighborhood" },
                        { name: "Dumbo", kind: "neighborhood", aliases: ["DUMBO"] },
                        { name: "Brooklyn Heights", kind: "neighborhood" },
                      ],
                    },
                    { name: "Queens", kind: "borough" },
                    { name: "The Bronx", kind: "borough", aliases: ["Bronx"] },
                    { name: "Staten Island", kind: "borough" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    zipCodes: ["10007", "10013", "10021", "10023", "10011", "10014", "11211", "11215"],
    propertyTypes: ["condo", "co-op", "townhouse", "loft", "new development"],
    primaryPropertyTypes: ["condo", "loft"],
    priceTiers: COMMON_PRICE_TIERS,
    buyerSegments: COMMON_BUYER_SEGMENTS,
    sellerSegments: COMMON_SELLER_SEGMENTS,
    terminology: {
      "co-op": "cooperative apartment requiring board approval",
      brownstone: "historic rowhouse, often Brooklyn",
      "classic six": "pre-war six-room apartment",
    },
    brokerages: [
      "Compass",
      "The Corcoran Group",
      "Douglas Elliman",
      "SERHANT",
      "Sotheby's International Realty",
      "Brown Harris Stevens",
    ],
    publications: [
      "The Real Deal",
      "Brick Underground",
      "Curbed New York",
      "Crain's New York Business",
    ],
    excludedPlaceNames: [
      {
        name: "Chinatown",
        reason:
          "Exists in many US cities — an unqualified Chinatown prompt is not attributable to NYC.",
      },
    ],
    templates: [
      ...standardTemplates(),
      {
        key: "coop-specialist",
        text: "Which {city} agents are best at getting buyers through co-op board approval?",
        category: "recommendation",
        tier: 2,
        audience: "buyer",
        scope: "city",
      },
      {
        key: "loft-specialist",
        text: "Which real estate teams specialize in {area} lofts?",
        category: "recommendation",
        tier: 1,
        audience: "general",
        scope: "neighborhood",
      },
    ],
  },
  {
    key: "jersey-city",
    version: 1,
    cityName: "Jersey City",
    hierarchy: {
      ...USA,
      children: [
        {
          name: "New Jersey",
          kind: "state",
          aliases: ["NJ"],
          children: [
            {
              name: "Hudson County",
              kind: "county",
              children: [
                {
                  name: "Jersey City",
                  kind: "city",
                  aliases: ["JC"],
                  children: [
                    {
                      name: "Downtown Jersey City",
                      kind: "neighborhood",
                      aliases: ["Downtown JC"],
                    },
                    { name: "Paulus Hook", kind: "neighborhood" },
                    { name: "Newport", kind: "neighborhood" },
                    { name: "Journal Square", kind: "neighborhood" },
                    { name: "The Heights", kind: "neighborhood", aliases: ["Jersey City Heights"] },
                    { name: "Bergen-Lafayette", kind: "neighborhood" },
                    { name: "Greenville", kind: "neighborhood" },
                  ],
                },
                { name: "Hoboken", kind: "city" },
              ],
            },
          ],
        },
      ],
    },
    zipCodes: ["07302", "07310", "07306", "07307", "07304"],
    propertyTypes: ["condo", "brownstone", "townhouse", "new construction"],
    primaryPropertyTypes: ["condo", "brownstone"],
    priceTiers: COMMON_PRICE_TIERS,
    buyerSegments: COMMON_BUYER_SEGMENTS,
    sellerSegments: COMMON_SELLER_SEGMENTS,
    terminology: {
      "gold coast": "Hudson River waterfront corridor facing Manhattan",
      "path-adjacent": "walkable to a PATH train station",
    },
    brokerages: [
      "Compass",
      "Corcoran Sawyer Smith",
      "Keller Williams",
      "Liberty Realty",
      "Brown Harris Stevens New Jersey",
    ],
    publications: ["Jersey Digs", "NJ.com Real Estate", "Hudson County View"],
    excludedPlaceNames: [
      {
        name: "The Heights",
        reason:
          'Ambiguous — "The Heights" names neighborhoods in many cities; prompts use the alias Jersey City Heights instead.',
      },
    ],
    templates: [
      ...standardTemplates(),
      {
        key: "nyc-commuter",
        text: "I work in Manhattan and want to buy in {city} — which agent should I use?",
        category: "recommendation",
        tier: 2,
        audience: "buyer",
        scope: "city",
      },
    ],
  },
  {
    key: "miami",
    version: 1,
    cityName: "Miami",
    hierarchy: {
      ...USA,
      children: [
        {
          name: "Florida",
          kind: "state",
          aliases: ["FL"],
          children: [
            {
              name: "Miami metropolitan area",
              kind: "metro",
              aliases: ["South Florida", "Greater Miami"],
              children: [
                {
                  name: "Miami",
                  kind: "city",
                  aliases: ["Miami, FL"],
                  children: [
                    { name: "Brickell", kind: "neighborhood" },
                    { name: "Edgewater", kind: "neighborhood" },
                    { name: "Wynwood", kind: "neighborhood" },
                    { name: "Coconut Grove", kind: "neighborhood", aliases: ["The Grove"] },
                    { name: "Coral Way", kind: "neighborhood" },
                    { name: "Little Havana", kind: "neighborhood" },
                    { name: "Design District", kind: "neighborhood" },
                    { name: "Downtown Miami", kind: "neighborhood" },
                  ],
                },
                {
                  name: "Miami Beach",
                  kind: "city",
                  children: [{ name: "South Beach", kind: "neighborhood", aliases: ["SoBe"] }],
                },
              ],
            },
          ],
        },
      ],
    },
    zipCodes: ["33131", "33132", "33137", "33127", "33133", "33139"],
    propertyTypes: ["condo", "single-family home", "waterfront home", "pre-construction condo"],
    primaryPropertyTypes: ["condo", "waterfront home"],
    priceTiers: COMMON_PRICE_TIERS,
    buyerSegments: COMMON_BUYER_SEGMENTS,
    sellerSegments: COMMON_SELLER_SEGMENTS,
    terminology: {
      "pre-construction": "condo sold from plans before the building completes",
      "waterfront": "on the bay, a canal, or the ocean",
    },
    brokerages: [
      "Compass",
      "Douglas Elliman",
      "ONE Sotheby's International Realty",
      "Cervera Real Estate",
      "Fortune International Realty",
      "Coldwell Banker Realty",
    ],
    publications: [
      "The Real Deal South Florida",
      "Miami Herald Real Estate",
      "South Florida Business Journal",
      "Miami Agent Magazine",
    ],
    excludedPlaceNames: [
      {
        name: "Downtown Miami",
        reason:
          'Answers to unqualified "downtown" prompts blur Downtown, Brickell, and Edgewater — measured under the city scope instead.',
      },
    ],
    templates: [
      ...standardTemplates(),
      {
        key: "preconstruction-specialist",
        text: "Which {city} agents specialize in pre-construction condo sales?",
        category: "recommendation",
        tier: 2,
        audience: "investor",
        scope: "city",
      },
    ],
  },
  {
    key: "chicago",
    version: 1,
    cityName: "Chicago",
    hierarchy: {
      ...USA,
      children: [
        {
          name: "Illinois",
          kind: "state",
          aliases: ["IL"],
          children: [
            {
              name: "Chicago metropolitan area",
              kind: "metro",
              aliases: ["Chicagoland"],
              children: [
                {
                  name: "Chicago",
                  kind: "city",
                  aliases: ["Chicago, IL"],
                  children: [
                    { name: "Lincoln Park", kind: "neighborhood" },
                    { name: "Wicker Park", kind: "neighborhood" },
                    { name: "Gold Coast", kind: "neighborhood" },
                    { name: "River North", kind: "neighborhood" },
                    { name: "Logan Square", kind: "neighborhood" },
                    { name: "Hyde Park", kind: "neighborhood" },
                    { name: "Lakeview", kind: "neighborhood" },
                    { name: "West Loop", kind: "neighborhood" },
                    { name: "Chinatown", kind: "neighborhood" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    zipCodes: ["60614", "60622", "60611", "60654", "60647", "60615"],
    propertyTypes: ["condo", "single-family home", "two-flat", "townhouse"],
    primaryPropertyTypes: ["condo", "single-family home"],
    priceTiers: COMMON_PRICE_TIERS,
    buyerSegments: COMMON_BUYER_SEGMENTS,
    sellerSegments: COMMON_SELLER_SEGMENTS,
    terminology: {
      "two-flat": "two-unit building, often owner-occupied with a rental",
      "greystone": "stone-faced rowhouse typical of the city",
    },
    brokerages: [
      "@properties Christie's International Real Estate",
      "Compass",
      "Coldwell Banker Realty",
      "Baird & Warner",
      "Berkshire Hathaway HomeServices Chicago",
      "Jameson Sotheby's International Realty",
    ],
    publications: [
      "Crain's Chicago Business",
      "Chicago Agent Magazine",
      "Block Club Chicago",
      "Chicago Tribune Real Estate",
    ],
    excludedPlaceNames: [
      {
        name: "Chinatown",
        reason:
          "Exists in many US cities — an unqualified Chinatown prompt is not attributable to Chicago.",
      },
    ],
    templates: [
      ...standardTemplates(),
      {
        key: "two-flat-specialist",
        text: "Which {city} agents know the two-flat and small multifamily market best?",
        category: "recommendation",
        tier: 2,
        audience: "investor",
        scope: "city",
      },
    ],
  },
  {
    key: "boston",
    version: 1,
    cityName: "Boston",
    hierarchy: {
      ...USA,
      children: [
        {
          name: "Massachusetts",
          kind: "state",
          aliases: ["MA"],
          children: [
            {
              name: "Greater Boston",
              kind: "metro",
              children: [
                {
                  name: "Boston",
                  kind: "city",
                  aliases: ["Boston, MA"],
                  children: [
                    { name: "Back Bay", kind: "neighborhood" },
                    { name: "Beacon Hill", kind: "neighborhood" },
                    { name: "South End", kind: "neighborhood" },
                    { name: "Seaport", kind: "neighborhood", aliases: ["Seaport District"] },
                    { name: "Charlestown", kind: "neighborhood" },
                    { name: "Jamaica Plain", kind: "neighborhood", aliases: ["JP"] },
                    { name: "North End", kind: "neighborhood" },
                    { name: "Fenway", kind: "neighborhood" },
                    { name: "Chinatown", kind: "neighborhood" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    zipCodes: ["02116", "02108", "02118", "02210", "02129", "02130"],
    propertyTypes: ["condo", "brownstone", "single-family home", "multi-family"],
    primaryPropertyTypes: ["condo", "brownstone"],
    priceTiers: COMMON_PRICE_TIERS,
    buyerSegments: COMMON_BUYER_SEGMENTS,
    sellerSegments: COMMON_SELLER_SEGMENTS,
    terminology: {
      brownstone: "historic rowhouse, Back Bay and South End especially",
      "triple-decker": "three-unit stacked house common across greater Boston",
    },
    brokerages: [
      "Compass",
      "Coldwell Banker Realty",
      "Gibson Sotheby's International Realty",
      "William Raveis",
      "Douglas Elliman",
      "Engel & Völkers Boston",
    ],
    publications: [
      "Boston Globe Real Estate",
      "Boston Agent Magazine",
      "Banker & Tradesman",
      "Boston.com Real Estate",
    ],
    excludedPlaceNames: [
      {
        name: "Chinatown",
        reason:
          "Exists in many US cities — an unqualified Chinatown prompt is not attributable to Boston.",
      },
    ],
    templates: [
      ...standardTemplates(),
      {
        key: "brownstone-specialist",
        text: "Which teams specialize in {area} brownstones?",
        category: "recommendation",
        tier: 1,
        audience: "general",
        scope: "neighborhood",
      },
    ],
  },
];

export function getMarketPack(key: string): MarketPackDefinition | null {
  return MARKET_PACKS.find((p) => p.key === key) ?? null;
}
