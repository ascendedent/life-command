// Plaid Personal Finance Category (PFC v2) -> our seeded category names.
// Detailed mappings win over primary fallbacks; anything unmapped lands in
// Uncategorized (and the review inbox) until a rule/merchant-map/user fixes it.

const DETAILED: Record<string, string> = {
  INCOME_WAGES: "Paycheck",
  INCOME_DIVIDENDS: "Dividends & Capital Gains",
  INCOME_INTEREST_EARNED: "Interest",
  INCOME_TAX_REFUND: "Refunds & Reimbursements",
  INCOME_RETIREMENT_PENSION: "Other Income",
  INCOME_UNEMPLOYMENT: "Other Income",

  TRANSFER_OUT_SAVINGS: "Savings Contribution",
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: "Investment Buy/Sell",
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: "Investment Buy/Sell",

  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: "Credit Card Payment",
  LOAN_PAYMENTS_CAR_PAYMENT: "Auto Payment",
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: "Mortgage",

  BANK_FEES_INTEREST_CHARGE: "Interest Paid",

  ENTERTAINMENT_MUSIC_AND_AUDIO: "Music",
  ENTERTAINMENT_VIDEO_GAMES: "Games",
  ENTERTAINMENT_TV_AND_MOVIES: "Streaming Services",
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: "Events & Tickets",

  FOOD_AND_DRINK_GROCERIES: "Groceries",
  FOOD_AND_DRINK_RESTAURANT: "Restaurants",
  FOOD_AND_DRINK_FAST_FOOD: "Restaurants",
  FOOD_AND_DRINK_COFFEE: "Coffee Shops",
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: "Alcohol & Bars",
  FOOD_AND_DRINK_VENDING_MACHINES: "Delivery & Takeout",

  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: "Clothing",
  GENERAL_MERCHANDISE_ELECTRONICS: "Electronics",
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: "Books",
  GENERAL_MERCHANDISE_PET_SUPPLIES: "Pets",
  GENERAL_MERCHANDISE_SPORTING_GOODS: "Hobbies",
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: "Shopping",
  GENERAL_MERCHANDISE_DISCOUNT_STORES: "Shopping",
  GENERAL_MERCHANDISE_SUPERSTORES: "Shopping",
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: "Shopping",
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: "Gifts",

  HOME_IMPROVEMENT_FURNITURE: "Home Goods",
  HOME_IMPROVEMENT_HARDWARE: "Home Improvement",
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: "Home Services",
  HOME_IMPROVEMENT_SECURITY: "Home Services",

  MEDICAL_DENTAL_CARE: "Dental",
  MEDICAL_EYE_CARE: "Vision",
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: "Pharmacy",
  MEDICAL_VETERINARY_SERVICES: "Pets",
  MEDICAL_NURSING_CARE: "Medical",

  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "Fitness",
  PERSONAL_CARE_HAIR_AND_BEAUTY: "Personal Care",
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: "Personal Care",

  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: "Legal & Professional",
  GENERAL_SERVICES_CONSULTING_AND_LEGAL: "Legal & Professional",
  GENERAL_SERVICES_EDUCATION: "Education",
  GENERAL_SERVICES_CHILDCARE: "Childcare",
  GENERAL_SERVICES_INSURANCE: "Insurance",
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: "Shipping & Postage",
  GENERAL_SERVICES_STORAGE: "Subscriptions",
  GENERAL_SERVICES_AUTOMOTIVE: "Auto Maintenance",

  GOVERNMENT_AND_NON_PROFIT_DONATIONS: "Charity",
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: "Taxes",
  GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES: "Taxes",

  TRANSPORTATION_GAS: "Gas",
  TRANSPORTATION_PARKING: "Parking & Tolls",
  TRANSPORTATION_TOLLS: "Parking & Tolls",
  TRANSPORTATION_PUBLIC_TRANSIT: "Public Transit",
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "Rideshare & Taxi",
  TRANSPORTATION_BIKES_AND_SCOOTERS: "Public Transit",

  TRAVEL_LODGING: "Hotels",
  TRAVEL_FLIGHTS: "Travel",
  TRAVEL_RENTAL_CARS: "Travel",

  RENT_AND_UTILITIES_RENT: "Rent",
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: "Internet",
  RENT_AND_UTILITIES_TELEPHONE: "Mobile Phone",
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: "Electric",
  RENT_AND_UTILITIES_WATER: "Water",
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: "Trash & Recycling",
};

const PRIMARY: Record<string, string> = {
  INCOME: "Other Income",
  TRANSFER_IN: "Transfer",
  TRANSFER_OUT: "Transfer",
  LOAN_PAYMENTS: "Loan Payment",
  BANK_FEES: "Bank Fees",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Restaurants",
  GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Home Improvement",
  MEDICAL: "Medical",
  PERSONAL_CARE: "Personal Care",
  GENERAL_SERVICES: "Miscellaneous",
  GOVERNMENT_AND_NON_PROFIT: "Taxes",
  TRANSPORTATION: "Other Transport",
  TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Electric",
};

/** Resolve a PFC primary/detailed pair to one of our seeded category names. */
export function pfcToCategoryName(
  primary: string | null | undefined,
  detailed: string | null | undefined
): string | null {
  if (detailed && DETAILED[detailed]) return DETAILED[detailed];
  if (primary && PRIMARY[primary]) return PRIMARY[primary];
  return null;
}
