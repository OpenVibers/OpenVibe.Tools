/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║               G H O S T C A M P   G R O C E R Y                 ║
 * ║             Budget Food Finder & Nutrition Optimizer             ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Finds cheapest food hitting all nutritional groups from 5 WA stores:
 *   - Walmart (scraping + built-in prices)
 *   - Safeway (built-in WA pricing data)
 *   - Dollar Tree ($1.25 fixed price model)
 *   - Grocery Outlet (discount pricing data)
 *   - Fred Meyer / Kroger (API + built-in pricing)
 *
 * Nutritional data from USDA FoodData Central API
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { haversine } = require('./utils');

// ─── Store Definitions ─────────────────────────────────────────────
const STORES = {
  walmart: {
    name: 'Walmart',
    icon: 'fa-store',
    color: '#0071dc',
    searchUrl: 'https://www.walmart.com/search?q=',
    storeFinderUrl: 'https://www.walmart.com/store/finder?location=',
    priceLevel: 1, // 1=budget, 2=mid, 3=premium
    description: 'Everyday low prices on Great Value staples',
  },
  fredmeyer: {
    name: 'Fred Meyer',
    icon: 'fa-cart-shopping',
    color: '#e21836',
    searchUrl: 'https://www.fredmeyer.com/search?query=',
    storeFinderUrl: 'https://www.fredmeyer.com/stores/search',
    priceLevel: 2,
    description: 'Kroger house brand + digital coupons',
    krogerChain: 'FRED MEYER',
    krogerApiBase: 'https://api.kroger.com/v1',
  },
  safeway: {
    name: 'Safeway',
    icon: 'fa-basket-shopping',
    color: '#e8351e',
    searchUrl: 'https://www.safeway.com/shop/search-results.html?q=',
    storeFinderUrl: 'https://local.safeway.com/search.html?q=',
    priceLevel: 2,
    description: 'Albertsons brand + club card deals',
  },
  dollartree: {
    name: 'Dollar Tree',
    icon: 'fa-dollar-sign',
    color: '#00a651',
    searchUrl: 'https://www.dollartree.com/search?q=',
    storeFinderUrl: 'https://www.dollartree.com/locations',
    priceLevel: 1,
    description: 'Most items $1.25 — small portions, pantry staples',
    fixedPrice: 1.25,
  },
  groceryoutlet: {
    name: 'Grocery Outlet',
    icon: 'fa-tags',
    color: '#ff6600',
    searchUrl: 'https://www.groceryoutlet.com',
    storeFinderUrl: 'https://www.groceryoutlet.com/store-locator',
    priceLevel: 1,
    description: 'Closeout/overstock deals — 40-70% off retail',
  },
};

// ─── Nutritional Groups (USDA MyPlate) ─────────────────────────────
const FOOD_GROUPS = {
  protein: {
    name: 'Protein',
    icon: 'fa-drumstick-bite',
    color: '#9b59b6',
    dailyMin: 50, // grams
    examples: 'Chicken, eggs, beans, peanut butter, canned tuna',
  },
  grains: {
    name: 'Grains',
    icon: 'fa-wheat-awn',
    color: '#e67e22',
    dailyMin: 170, // grams (6 oz equiv)
    examples: 'Rice, bread, pasta, oatmeal, tortillas',
  },
  vegetables: {
    name: 'Vegetables',
    icon: 'fa-carrot',
    color: '#27ae60',
    dailyMin: 300, // grams (~2.5 cups)
    examples: 'Carrots, potatoes, canned corn, frozen mixed veggies',
  },
  fruits: {
    name: 'Fruits',
    icon: 'fa-apple-whole',
    color: '#e74c3c',
    dailyMin: 200, // grams (~2 cups)
    examples: 'Bananas, apples, oranges, canned fruit',
  },
  dairy: {
    name: 'Dairy',
    icon: 'fa-glass-water',
    color: '#3498db',
    dailyMin: 720, // ml (~3 cups)
    examples: 'Milk, cheese, yogurt',
  },
  fats: {
    name: 'Fats & Oils',
    icon: 'fa-oil-can',
    color: '#f1c40f',
    dailyMin: 25, // grams
    examples: 'Cooking oil, butter, peanut butter, avocado',
  },
};

// ─── Comprehensive Budget Food Database ────────────────────────────
// Real WA prices as of 2025, covering all nutritional groups
const BUDGET_FOODS = [
  // ═══ PROTEIN ═══
  {
    id: 'eggs-dozen',
    name: 'Large Eggs (1 dozen)',
    group: 'protein',
    servings: 12,
    servingSize: '1 egg',
    calories: 70,
    proteinG: 6,
    carbsG: 0.5,
    fatG: 5,
    fiberG: 0,
    prices: { walmart: 3.24, fredmeyer: 3.49, safeway: 3.79, dollartree: null, groceryoutlet: 2.99 },
    shelfStable: false,
    campFriendly: 2,
    tags: ['breakfast', 'versatile', 'complete-protein'],
  },
  {
    id: 'chicken-breast',
    name: 'Chicken Breasts (per lb)',
    group: 'protein',
    servings: 3,
    servingSize: '5 oz',
    calories: 165,
    proteinG: 31,
    carbsG: 0,
    fatG: 3.6,
    fiberG: 0,
    prices: { walmart: 2.57, fredmeyer: 2.99, safeway: 3.49, dollartree: null, groceryoutlet: 1.99 },
    shelfStable: false,
    campFriendly: 1,
    tags: ['lean', 'high-protein'],
  },
  {
    id: 'canned-tuna',
    name: 'Canned Tuna (5 oz)',
    group: 'protein',
    servings: 2.5,
    servingSize: '2 oz',
    calories: 60,
    proteinG: 13,
    carbsG: 0,
    fatG: 0.5,
    fiberG: 0,
    prices: { walmart: 1.08, fredmeyer: 1.25, safeway: 1.39, dollartree: 1.25, groceryoutlet: 0.99 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'lightweight', 'omega-3'],
  },
  {
    id: 'peanut-butter',
    name: 'Peanut Butter (16 oz)',
    group: 'protein',
    servings: 15,
    servingSize: '2 tbsp',
    calories: 190,
    proteinG: 7,
    carbsG: 7,
    fatG: 16,
    fiberG: 2,
    prices: { walmart: 2.14, fredmeyer: 2.49, safeway: 2.79, dollartree: 1.25, groceryoutlet: 1.99 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'calorie-dense', 'camping-essential'],
  },
  {
    id: 'dried-beans',
    name: 'Dried Pinto Beans (1 lb)',
    group: 'protein',
    servings: 12,
    servingSize: '1/4 cup dry',
    calories: 150,
    proteinG: 10,
    carbsG: 28,
    fatG: 0.5,
    fiberG: 10,
    prices: { walmart: 1.28, fredmeyer: 1.49, safeway: 1.69, dollartree: 1.25, groceryoutlet: 1.19 },
    shelfStable: true,
    campFriendly: 3,
    tags: ['shelf-stable', 'fiber', 'cheap-protein'],
  },
  {
    id: 'canned-beans',
    name: 'Canned Black Beans (15 oz)',
    group: 'protein',
    servings: 3.5,
    servingSize: '1/2 cup',
    calories: 110,
    proteinG: 7,
    carbsG: 20,
    fatG: 0.5,
    fiberG: 8,
    prices: { walmart: 0.78, fredmeyer: 0.99, safeway: 1.09, dollartree: 1.25, groceryoutlet: 0.79 },
    shelfStable: true,
    campFriendly: 4,
    tags: ['shelf-stable', 'fiber', 'ready-to-eat'],
  },
  {
    id: 'hot-dogs',
    name: 'Hot Dogs (8 ct, 12 oz)',
    group: 'protein',
    servings: 8,
    servingSize: '1 frank',
    calories: 150,
    proteinG: 5,
    carbsG: 2,
    fatG: 13,
    fiberG: 0,
    prices: { walmart: 1.00, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.99 },
    shelfStable: false,
    campFriendly: 4,
    tags: ['easy-cook', 'campfire', 'budget-king'],
  },
  {
    id: 'ground-beef',
    name: 'Ground Beef 73/27 (1 lb)',
    group: 'protein',
    servings: 4,
    servingSize: '4 oz',
    calories: 280,
    proteinG: 19,
    carbsG: 0,
    fatG: 23,
    fiberG: 0,
    prices: { walmart: 5.94, fredmeyer: 5.99, safeway: 6.49, dollartree: null, groceryoutlet: 4.99 },
    shelfStable: false,
    campFriendly: 2,
    tags: ['high-calorie', 'iron-rich'],
  },
  {
    id: 'ramen-12pk',
    name: 'Ramen Noodles (12 pack)',
    group: 'grains',
    servings: 12,
    servingSize: '1 packet',
    calories: 188,
    proteinG: 4,
    carbsG: 26,
    fatG: 7,
    fiberG: 1,
    prices: { walmart: 3.97, fredmeyer: 3.99, safeway: 4.29, dollartree: 1.25, groceryoutlet: 2.99 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'ultralight', 'just-add-water'],
  },

  // ═══ GRAINS ═══
  {
    id: 'white-rice',
    name: 'Long Grain White Rice (2 lb)',
    group: 'grains',
    servings: 20,
    servingSize: '1/4 cup dry',
    calories: 160,
    proteinG: 3,
    carbsG: 36,
    fatG: 0,
    fiberG: 0,
    prices: { walmart: 1.42, fredmeyer: 1.69, safeway: 1.89, dollartree: 1.25, groceryoutlet: 1.49 },
    shelfStable: true,
    campFriendly: 4,
    tags: ['shelf-stable', 'bulk-calories', 'versatile'],
  },
  {
    id: 'spaghetti',
    name: 'Spaghetti (16 oz)',
    group: 'grains',
    servings: 8,
    servingSize: '2 oz dry',
    calories: 200,
    proteinG: 7,
    carbsG: 41,
    fatG: 1,
    fiberG: 2,
    prices: { walmart: 0.98, fredmeyer: 1.15, safeway: 1.29, dollartree: 1.25, groceryoutlet: 0.89 },
    shelfStable: true,
    campFriendly: 3,
    tags: ['shelf-stable', 'energy-dense'],
  },
  {
    id: 'bread-white',
    name: 'White Bread (20 oz)',
    group: 'grains',
    servings: 20,
    servingSize: '1 slice',
    calories: 65,
    proteinG: 2,
    carbsG: 13,
    fatG: 1,
    fiberG: 0.5,
    prices: { walmart: 1.18, fredmeyer: 1.39, safeway: 1.49, dollartree: 1.25, groceryoutlet: 1.29 },
    shelfStable: false,
    campFriendly: 4,
    tags: ['sandwich-base', 'breakfast'],
  },
  {
    id: 'oatmeal',
    name: 'Oats, Old Fashioned (42 oz)',
    group: 'grains',
    servings: 30,
    servingSize: '1/2 cup dry',
    calories: 150,
    proteinG: 5,
    carbsG: 27,
    fatG: 3,
    fiberG: 4,
    prices: { walmart: 3.48, fredmeyer: 3.69, safeway: 3.99, dollartree: 1.25, groceryoutlet: 2.99 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'fiber', 'breakfast', 'just-add-water'],
  },
  {
    id: 'tortillas',
    name: 'Flour Tortillas (10 ct)',
    group: 'grains',
    servings: 10,
    servingSize: '1 tortilla',
    calories: 140,
    proteinG: 4,
    carbsG: 24,
    fatG: 3,
    fiberG: 1,
    prices: { walmart: 1.96, fredmeyer: 2.29, safeway: 2.49, dollartree: 1.25, groceryoutlet: 1.79 },
    shelfStable: false,
    campFriendly: 5,
    tags: ['wraps', 'versatile', 'no-cook'],
  },
  {
    id: 'jiffy-mix',
    name: 'Jiffy Corn Muffin Mix (8.5 oz)',
    group: 'grains',
    servings: 6,
    servingSize: '1 muffin',
    calories: 180,
    proteinG: 3,
    carbsG: 28,
    fatG: 5,
    fiberG: 1,
    prices: { walmart: 0.67, fredmeyer: 0.79, safeway: 0.89, dollartree: 1.25, groceryoutlet: 0.69 },
    shelfStable: true,
    campFriendly: 2,
    tags: ['shelf-stable', 'baking'],
  },

  // ═══ VEGETABLES ═══
  {
    id: 'potatoes-5lb',
    name: 'Russet Potatoes (5 lb)',
    group: 'vegetables',
    servings: 10,
    servingSize: '1 medium',
    calories: 160,
    proteinG: 4,
    carbsG: 37,
    fatG: 0,
    fiberG: 4,
    prices: { walmart: 2.47, fredmeyer: 2.79, safeway: 2.99, dollartree: null, groceryoutlet: 2.49 },
    shelfStable: true,
    campFriendly: 3,
    tags: ['calorie-dense', 'campfire', 'versatile'],
  },
  {
    id: 'canned-corn',
    name: 'Canned Corn (15 oz)',
    group: 'vegetables',
    servings: 3.5,
    servingSize: '1/2 cup',
    calories: 60,
    proteinG: 2,
    carbsG: 14,
    fatG: 0.5,
    fiberG: 2,
    prices: { walmart: 0.76, fredmeyer: 0.89, safeway: 0.99, dollartree: 1.25, groceryoutlet: 0.69 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'ready-to-eat'],
  },
  {
    id: 'baby-carrots',
    name: 'Baby Carrots (1 lb)',
    group: 'vegetables',
    servings: 6,
    servingSize: '3 oz',
    calories: 35,
    proteinG: 1,
    carbsG: 8,
    fatG: 0,
    fiberG: 2,
    prices: { walmart: 1.17, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 1.09 },
    shelfStable: false,
    campFriendly: 5,
    tags: ['ready-to-eat', 'no-cook', 'vitamin-a'],
  },
  {
    id: 'canned-green-beans',
    name: 'Canned Green Beans (14.5 oz)',
    group: 'vegetables',
    servings: 3.5,
    servingSize: '1/2 cup',
    calories: 20,
    proteinG: 1,
    carbsG: 4,
    fatG: 0,
    fiberG: 1,
    prices: { walmart: 0.72, fredmeyer: 0.85, safeway: 0.99, dollartree: 1.25, groceryoutlet: 0.65 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'low-calorie'],
  },
  {
    id: 'frozen-mixed-veg',
    name: 'Frozen Mixed Vegetables (12 oz)',
    group: 'vegetables',
    servings: 4,
    servingSize: '3/4 cup',
    calories: 50,
    proteinG: 2,
    carbsG: 10,
    fatG: 0,
    fiberG: 3,
    prices: { walmart: 1.14, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.99 },
    shelfStable: false,
    campFriendly: 1,
    tags: ['needs-freezer', 'vitamin-rich'],
  },
  {
    id: 'onion-3lb',
    name: 'Yellow Onions (3 lb bag)',
    group: 'vegetables',
    servings: 9,
    servingSize: '1 medium',
    calories: 45,
    proteinG: 1,
    carbsG: 11,
    fatG: 0,
    fiberG: 1,
    prices: { walmart: 2.12, fredmeyer: 2.29, safeway: 2.49, dollartree: null, groceryoutlet: 1.99 },
    shelfStable: true,
    campFriendly: 3,
    tags: ['flavor-base', 'long-lasting'],
  },
  {
    id: 'canned-tomatoes',
    name: 'Diced Tomatoes (14.5 oz can)',
    group: 'vegetables',
    servings: 3.5,
    servingSize: '1/2 cup',
    calories: 25,
    proteinG: 1,
    carbsG: 5,
    fatG: 0,
    fiberG: 1,
    prices: { walmart: 0.78, fredmeyer: 0.89, safeway: 0.99, dollartree: 1.25, groceryoutlet: 0.75 },
    shelfStable: true,
    campFriendly: 4,
    tags: ['shelf-stable', 'cooking-base', 'vitamin-c'],
  },

  // ═══ FRUITS ═══
  {
    id: 'bananas',
    name: 'Bananas (per lb, ~3 bananas)',
    group: 'fruits',
    servings: 3,
    servingSize: '1 medium',
    calories: 105,
    proteinG: 1,
    carbsG: 27,
    fatG: 0,
    fiberG: 3,
    prices: { walmart: 0.50, fredmeyer: 0.59, safeway: 0.69, dollartree: null, groceryoutlet: 0.49 },
    shelfStable: false,
    campFriendly: 5,
    tags: ['no-cook', 'potassium', 'energy'],
  },
  {
    id: 'apples-3lb',
    name: 'Gala Apples (3 lb bag)',
    group: 'fruits',
    servings: 7,
    servingSize: '1 medium',
    calories: 95,
    proteinG: 0.5,
    carbsG: 25,
    fatG: 0,
    fiberG: 4,
    prices: { walmart: 3.47, fredmeyer: 3.69, safeway: 3.99, dollartree: null, groceryoutlet: 2.99 },
    shelfStable: false,
    campFriendly: 5,
    tags: ['no-cook', 'fiber', 'portable'],
  },
  {
    id: 'oranges-3lb',
    name: 'Oranges (3 lb bag)',
    group: 'fruits',
    servings: 6,
    servingSize: '1 medium',
    calories: 65,
    proteinG: 1,
    carbsG: 16,
    fatG: 0,
    fiberG: 3,
    prices: { walmart: 3.57, fredmeyer: 3.79, safeway: 3.99, dollartree: null, groceryoutlet: 2.99 },
    shelfStable: false,
    campFriendly: 5,
    tags: ['no-cook', 'vitamin-c', 'portable'],
  },
  {
    id: 'canned-fruit',
    name: 'Canned Peaches (15 oz)',
    group: 'fruits',
    servings: 3.5,
    servingSize: '1/2 cup',
    calories: 60,
    proteinG: 0,
    carbsG: 15,
    fatG: 0,
    fiberG: 1,
    prices: { walmart: 1.18, fredmeyer: 1.39, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.99 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'ready-to-eat', 'sweet'],
  },
  {
    id: 'raisins',
    name: 'Raisins (6 oz box)',
    group: 'fruits',
    servings: 4,
    servingSize: '1/4 cup',
    calories: 120,
    proteinG: 1,
    carbsG: 32,
    fatG: 0,
    fiberG: 2,
    prices: { walmart: 1.98, fredmeyer: 2.19, safeway: 2.39, dollartree: 1.25, groceryoutlet: 1.49 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'energy-dense', 'trail-snack'],
  },
  {
    id: 'strawberries',
    name: 'Fresh Strawberries (1 lb)',
    group: 'fruits',
    servings: 4,
    servingSize: '1 cup',
    calories: 50,
    proteinG: 1,
    carbsG: 12,
    fatG: 0,
    fiberG: 3,
    prices: { walmart: 2.82, fredmeyer: 2.99, safeway: 3.29, dollartree: null, groceryoutlet: 2.49 },
    shelfStable: false,
    campFriendly: 4,
    tags: ['vitamin-c', 'antioxidants'],
  },

  // ═══ DAIRY ═══
  {
    id: 'whole-milk',
    name: 'Whole Milk (1 gallon)',
    group: 'dairy',
    servings: 16,
    servingSize: '1 cup',
    calories: 150,
    proteinG: 8,
    carbsG: 12,
    fatG: 8,
    fiberG: 0,
    prices: { walmart: 2.92, fredmeyer: 3.19, safeway: 3.49, dollartree: null, groceryoutlet: 2.99 },
    shelfStable: false,
    campFriendly: 1,
    tags: ['calcium', 'complete-protein', 'vitamin-d'],
  },
  {
    id: 'cheese-block',
    name: 'Cheddar Cheese Block (8 oz)',
    group: 'dairy',
    servings: 8,
    servingSize: '1 oz',
    calories: 110,
    proteinG: 7,
    carbsG: 1,
    fatG: 9,
    fiberG: 0,
    prices: { walmart: 1.87, fredmeyer: 2.19, safeway: 2.49, dollartree: null, groceryoutlet: 1.79 },
    shelfStable: false,
    campFriendly: 3,
    tags: ['calcium', 'protein', 'portable'],
  },
  {
    id: 'yogurt',
    name: 'Yogurt (32 oz tub)',
    group: 'dairy',
    servings: 4,
    servingSize: '1 cup',
    calories: 130,
    proteinG: 12,
    carbsG: 17,
    fatG: 0,
    fiberG: 0,
    prices: { walmart: 2.68, fredmeyer: 2.89, safeway: 3.19, dollartree: null, groceryoutlet: 2.49 },
    shelfStable: false,
    campFriendly: 1,
    tags: ['probiotics', 'breakfast'],
  },
  {
    id: 'powdered-milk',
    name: 'Powdered Milk (25.6 oz)',
    group: 'dairy',
    servings: 24,
    servingSize: '1/3 cup powder',
    calories: 80,
    proteinG: 8,
    carbsG: 12,
    fatG: 0,
    fiberG: 0,
    prices: { walmart: 5.97, fredmeyer: 6.49, safeway: 6.99, dollartree: null, groceryoutlet: 4.99 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'lightweight', 'camping-essential'],
  },

  // ═══ FATS & OILS ═══
  {
    id: 'cooking-oil',
    name: 'Vegetable Oil (48 fl oz)',
    group: 'fats',
    servings: 96,
    servingSize: '1 tbsp',
    calories: 120,
    proteinG: 0,
    carbsG: 0,
    fatG: 14,
    fiberG: 0,
    prices: { walmart: 3.74, fredmeyer: 3.99, safeway: 4.49, dollartree: 1.25, groceryoutlet: 3.49 },
    shelfStable: true,
    campFriendly: 3,
    tags: ['cooking-essential', 'calorie-dense'],
  },
  {
    id: 'butter',
    name: 'Butter (16 oz / 4 sticks)',
    group: 'fats',
    servings: 32,
    servingSize: '1 tbsp',
    calories: 100,
    proteinG: 0,
    carbsG: 0,
    fatG: 11,
    fiberG: 0,
    prices: { walmart: 3.48, fredmeyer: 3.79, safeway: 3.99, dollartree: null, groceryoutlet: 2.99 },
    shelfStable: false,
    campFriendly: 2,
    tags: ['cooking', 'flavor'],
  },
  {
    id: 'avocado',
    name: 'Fresh Avocado (each)',
    group: 'fats',
    servings: 3,
    servingSize: '1/3 avocado',
    calories: 80,
    proteinG: 1,
    carbsG: 4,
    fatG: 7,
    fiberG: 3,
    prices: { walmart: 0.55, fredmeyer: 0.79, safeway: 0.99, dollartree: null, groceryoutlet: 0.50 },
    shelfStable: false,
    campFriendly: 4,
    tags: ['healthy-fats', 'potassium', 'no-cook'],
  },

  // ═══ BONUS: CAMP-READY MEALS ═══
  {
    id: 'mac-cheese',
    name: 'Mac & Cheese Box (7.25 oz)',
    group: 'grains',
    servings: 3,
    servingSize: '1 cup prepared',
    calories: 220,
    proteinG: 8,
    carbsG: 48,
    fatG: 2,
    fiberG: 2,
    prices: { walmart: 0.52, fredmeyer: 0.79, safeway: 0.89, dollartree: 1.25, groceryoutlet: 0.59 },
    shelfStable: true,
    campFriendly: 3,
    tags: ['shelf-stable', 'kid-friendly'],
  },
  {
    id: 'canned-soup',
    name: 'Canned Soup, Chicken Noodle (10.5 oz)',
    group: 'protein',
    servings: 2.5,
    servingSize: '1/2 can',
    calories: 60,
    proteinG: 3,
    carbsG: 8,
    fatG: 2,
    fiberG: 1,
    prices: { walmart: 0.98, fredmeyer: 1.09, safeway: 1.19, dollartree: 1.25, groceryoutlet: 0.89 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'heat-and-eat', 'comfort-food'],
  },
  {
    id: 'canned-chili',
    name: 'Canned Chili with Beans (15 oz)',
    group: 'protein',
    servings: 2,
    servingSize: '1 cup',
    calories: 240,
    proteinG: 16,
    carbsG: 25,
    fatG: 8,
    fiberG: 7,
    prices: { walmart: 1.48, fredmeyer: 1.69, safeway: 1.89, dollartree: 1.25, groceryoutlet: 1.29 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'high-protein', 'heat-and-eat', 'complete-meal'],
  },
  {
    id: 'trail-mix',
    name: 'Trail Mix (10 oz)',
    group: 'fats',
    servings: 7,
    servingSize: '3 tbsp',
    calories: 160,
    proteinG: 5,
    carbsG: 15,
    fatG: 10,
    fiberG: 2,
    prices: { walmart: 2.98, fredmeyer: 3.49, safeway: 3.99, dollartree: 1.25, groceryoutlet: 2.49 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'trail-snack', 'energy-dense'],
  },
  {
    id: 'granola-bars',
    name: 'Granola Bars (6 ct)',
    group: 'grains',
    servings: 6,
    servingSize: '1 bar',
    calories: 100,
    proteinG: 2,
    carbsG: 19,
    fatG: 3,
    fiberG: 1,
    prices: { walmart: 1.96, fredmeyer: 2.29, safeway: 2.79, dollartree: 1.25, groceryoutlet: 1.49 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'portable', 'hiking-snack'],
  },
  {
    id: 'sardines',
    name: 'Sardines (3.75 oz tin)',
    group: 'protein',
    servings: 2,
    servingSize: '~3 fish',
    calories: 120,
    proteinG: 13,
    carbsG: 0,
    fatG: 7,
    fiberG: 0,
    prices: { walmart: 1.08, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.89 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'omega-3', 'calcium', 'no-cook'],
  },
  {
    id: 'instant-coffee',
    name: 'Instant Coffee (8 oz jar)',
    group: 'grains', // misc — caffeine/morale item, no real nutrition group
    servings: 120,
    servingSize: '1 tsp',
    calories: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    fiberG: 0,
    prices: { walmart: 4.64, fredmeyer: 4.99, safeway: 5.49, dollartree: 1.25, groceryoutlet: 3.99 },
    shelfStable: true,
    campFriendly: 5,
    tags: ['shelf-stable', 'morale-booster', 'just-add-water'],
  },
];

// ─── Find Nearby Stores via Overpass API ───────────────────────────
async function findNearbyStores(lat, lon, radiusMeters = 8000) {
  const stores = [];
  const storeQueries = [
    { type: 'walmart', query: '"brand"~"Walmart"' },
    { type: 'fredmeyer', query: '"brand"~"Fred Meyer"' },
    { type: 'safeway', query: '"brand"~"Safeway"' },
    { type: 'dollartree', query: '"brand"~"Dollar Tree"' },
    { type: 'groceryoutlet', query: '"brand"~"Grocery Outlet"' },
  ];

  // Single Overpass query for all stores
  const filters = storeQueries.map(s => `node["shop"~"supermarket|convenience|variety_store"][${s.query}](around:${radiusMeters},${lat},${lon});`).join('\n');
  const query = `[out:json][timeout:15];(\n${filters}\n);out body;`;

  try {
    const resp = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    if (resp.data?.elements) {
      for (const el of resp.data.elements) {
        const brand = (el.tags?.brand || '').toLowerCase();
        let storeType = null;
        if (brand.includes('walmart')) storeType = 'walmart';
        else if (brand.includes('fred meyer')) storeType = 'fredmeyer';
        else if (brand.includes('safeway')) storeType = 'safeway';
        else if (brand.includes('dollar tree')) storeType = 'dollartree';
        else if (brand.includes('grocery outlet')) storeType = 'groceryoutlet';

        if (storeType) {
          stores.push({
            type: storeType,
            name: el.tags?.name || STORES[storeType].name,
            lat: el.lat,
            lon: el.lon,
            address: formatOSMAddress(el.tags),
            distance: haversine(lat, lon, el.lat, el.lon),
          });
        }
      }
    }
  } catch (err) {
    console.warn('Store locator error:', err.message);
  }

  stores.sort((a, b) => a.distance - b.distance);
  return stores;
}

function formatOSMAddress(tags) {
  if (!tags) return '';
  const parts = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:state']].filter(Boolean);
  return parts.join(' ') || tags.name || '';
}

// ─── Find Food Banks, Soup Kitchens, Community Fridges ─────────────
const FOOD_BANK_TYPES = {
  food_bank:     { label: 'Food Bank',        icon: 'fa-boxes-stacked', color: '#ef4444' },
  soup_kitchen:  { label: 'Soup Kitchen',      icon: 'fa-bowl-food',    color: '#f97316' },
  food_sharing:  { label: 'Community Fridge',   icon: 'fa-temperature-low', color: '#06b6d4' },
  give_box:      { label: 'Free Pantry Box',    icon: 'fa-box-open',     color: '#8b5cf6' },
};

async function findFoodBanks(lat, lon, radiusMeters = 16000) {
  const query = `[out:json][timeout:25];
(
  // Food banks
  node["amenity"="social_facility"]["social_facility"="food_bank"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"]["social_facility"="food_bank"](around:${radiusMeters},${lat},${lon});
  node["amenity"="food_bank"](around:${radiusMeters},${lat},${lon});

  // Soup kitchens
  node["amenity"="social_facility"]["social_facility"="soup_kitchen"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"]["social_facility"="soup_kitchen"](around:${radiusMeters},${lat},${lon});

  // Community fridges / food sharing
  node["amenity"="food_sharing"](around:${radiusMeters},${lat},${lon});

  // Give boxes (community pantries)
  node["amenity"="give_box"](around:${radiusMeters},${lat},${lon});
);
out center body;
>;
out skel qt;
`;

  try {
    const resp = await axios.post('https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(query)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    );

    const results = [];
    const seen = new Set();

    for (const el of (resp.data?.elements || [])) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;

      const tags = el.tags || {};
      const key = `${elLat.toFixed(4)}-${elLon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Classify
      let fbType = 'food_bank';
      if (tags.social_facility === 'soup_kitchen') fbType = 'soup_kitchen';
      else if (tags.amenity === 'food_sharing') fbType = 'food_sharing';
      else if (tags.amenity === 'give_box') fbType = 'give_box';

      const typeDef = FOOD_BANK_TYPES[fbType];
      const dist = haversine(lat, lon, elLat, elLon);

      // Build description
      const desc = [];
      if (tags.description) desc.push(tags.description);
      if (tags.operator) desc.push(`Operated by ${tags.operator}`);
      if (tags.opening_hours) desc.push(`Hours: ${tags.opening_hours}`);
      if (tags.phone) desc.push(`Phone: ${tags.phone}`);
      if (tags.website) desc.push(tags.website);
      if (tags.wheelchair === 'yes') desc.push('Wheelchair accessible');
      if (tags.social_facility_for) desc.push(`Serves: ${tags.social_facility_for.replace(/;/g, ', ')}`);

      // Determine what's offered
      const offers = [];
      if (fbType === 'food_bank') offers.push('Pre-packaged food');
      if (fbType === 'soup_kitchen') offers.push('Hot prepared meals');
      if (fbType === 'food_sharing') {
        offers.push('Community drop-off/pick-up');
        if (tags.fridge === 'yes') offers.push('Has fridge');
      }
      if (fbType === 'give_box') offers.push('Free pantry items');
      if (tags.fee === 'no' || !tags.fee) offers.push('Free');

      results.push({
        id: `fb-${el.type}-${el.id}`,
        name: tags.name || typeDef.label,
        type: fbType,
        typeLabel: typeDef.label,
        icon: typeDef.icon,
        color: typeDef.color,
        lat: elLat,
        lon: elLon,
        distance: Math.round(dist * 10) / 10,
        address: formatOSMAddress(tags),
        description: desc.join(' | ') || typeDef.label,
        hours: tags.opening_hours || null,
        phone: tags.phone || null,
        website: tags.website || null,
        wheelchair: tags.wheelchair === 'yes',
        offers,
        osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      });
    }

    results.sort((a, b) => a.distance - b.distance);

    return {
      results,
      counts: {
        food_bank: results.filter(r => r.type === 'food_bank').length,
        soup_kitchen: results.filter(r => r.type === 'soup_kitchen').length,
        food_sharing: results.filter(r => r.type === 'food_sharing').length,
        give_box: results.filter(r => r.type === 'give_box').length,
      },
      total: results.length,
    };
  } catch (err) {
    console.warn('Food bank search error:', err.message);
    return { results: [], counts: {}, total: 0, error: err.message };
  }
}

// ─── Walmart Price Scraper ─────────────────────────────────────────
async function scrapeWalmartPrices(searchTerm) {
  try {
    const url = `https://www.walmart.com/search?q=${encodeURIComponent(searchTerm)}`;
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000,
    });

    const $ = cheerio.load(resp.data);
    const products = [];

    // Try parsing product cards from search results
    $('[data-item-id]').each((i, el) => {
      if (i >= 5) return; // limit
      const name = $(el).find('[data-automation-id="product-title"]').text().trim();
      const priceText = $(el).find('[data-automation-id="product-price"]').text().trim();
      const priceMatch = priceText.match(/\$(\d+\.?\d*)/);
      if (name && priceMatch) {
        products.push({ name: name.slice(0, 80), price: parseFloat(priceMatch[1]) });
      }
    });

    // Fallback: regex price extraction from raw HTML
    if (products.length === 0) {
      const pricePattern = /\$(\d+\.\d{2})\s*[\d.]+\s*¢\/(?:oz|lb|fl oz)/g;
      let match;
      while ((match = pricePattern.exec(resp.data)) !== null && products.length < 5) {
        products.push({ name: searchTerm, price: parseFloat(match[1]) });
      }
    }

    return products;
  } catch (err) {
    console.warn('Walmart scrape error:', err.message);
    return [];
  }
}

// ─── USDA FoodData Central Nutrition Lookup ────────────────────────
async function getNutritionData(foodName) {
  try {
    const resp = await axios.get('https://api.nal.usda.gov/fdc/v1/foods/search', {
      params: {
        api_key: 'DEMO_KEY',
        query: foodName,
        pageSize: 1,
        dataType: 'Survey (FNDDS)',
      },
      timeout: 8000,
    });

    if (resp.data?.foods?.[0]) {
      const food = resp.data.foods[0];
      const nutrients = {};
      for (const n of (food.foodNutrients || [])) {
        nutrients[n.nutrientName] = { value: n.value, unit: n.unitName };
      }
      return {
        description: food.description,
        calories: nutrients['Energy']?.value || 0,
        protein: nutrients['Protein']?.value || 0,
        carbs: nutrients['Carbohydrate, by difference']?.value || 0,
        fat: nutrients['Total lipid (fat)']?.value || 0,
        fiber: nutrients['Fiber, total dietary']?.value || 0,
        vitaminC: nutrients['Vitamin C, total ascorbic acid']?.value || 0,
        calcium: nutrients['Calcium, Ca']?.value || 0,
        iron: nutrients['Iron, Fe']?.value || 0,
        potassium: nutrients['Potassium, K']?.value || 0,
      };
    }
    return null;
  } catch (err) {
    console.warn('USDA API error:', err.message);
    return null;
  }
}

// ─── Meal Assignments (which items fit which meals) ────────────────
const MEAL_TAGS = {
  // Map food IDs to meal suitability: breakfast, lunch, dinner, snack
  'eggs-dozen': ['breakfast'],
  'chicken-breast': ['lunch', 'dinner'],
  'canned-tuna': ['lunch', 'snack'],
  'peanut-butter': ['breakfast', 'snack'],
  'dried-beans': ['lunch', 'dinner'],
  'canned-beans': ['lunch', 'dinner'],
  'hot-dogs': ['lunch', 'dinner'],
  'ground-beef': ['dinner'],
  'ramen-12pk': ['lunch', 'dinner'],
  'white-rice': ['lunch', 'dinner'],
  'spaghetti': ['dinner'],
  'bread-white': ['breakfast', 'lunch', 'snack'],
  'oatmeal': ['breakfast'],
  'tortillas': ['lunch', 'dinner'],
  'jiffy-mix': ['breakfast', 'snack'],
  'potatoes-5lb': ['lunch', 'dinner'],
  'canned-corn': ['lunch', 'dinner'],
  'baby-carrots': ['lunch', 'snack'],
  'canned-green-beans': ['lunch', 'dinner'],
  'frozen-mixed-veg': ['dinner'],
  'onion-3lb': ['lunch', 'dinner'],
  'canned-tomatoes': ['lunch', 'dinner'],
  'bananas': ['breakfast', 'snack'],
  'apples-3lb': ['breakfast', 'snack'],
  'oranges-3lb': ['breakfast', 'snack'],
  'canned-fruit': ['breakfast', 'snack'],
  'raisins': ['breakfast', 'snack'],
  'strawberries': ['breakfast', 'snack'],
  'whole-milk': ['breakfast'],
  'cheese-block': ['lunch', 'snack'],
  'yogurt': ['breakfast', 'snack'],
  'powdered-milk': ['breakfast'],
  'cooking-oil': ['lunch', 'dinner'],
  'butter': ['breakfast', 'lunch', 'dinner'],
  'avocado': ['lunch', 'snack'],
  'mac-cheese': ['lunch', 'dinner'],
  'canned-soup': ['lunch', 'dinner'],
  'canned-chili': ['lunch', 'dinner'],
  'trail-mix': ['snack'],
  'granola-bars': ['breakfast', 'snack'],
  'sardines': ['lunch', 'snack'],
  'instant-coffee': ['breakfast'],
};

// ─── Fisher-Yates shuffle ──────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Score food considering distance to store ──────────────────────
function scoreFood(food, nearbyStores, distanceWeight = 0.3) {
  // Base score: calories per dollar (higher = better)
  const baseScore = food.caloriesPerDollar;

  if (!nearbyStores || nearbyStores.length === 0) return baseScore;

  // Find closest store of the cheapest type
  const matchingStores = nearbyStores.filter(s => s.type === food.cheapestStore);
  if (matchingStores.length === 0) {
    // Store not nearby — penalize heavily
    return baseScore * (1 - distanceWeight * 0.9);
  }

  const closestDist = matchingStores[0].distance; // already sorted by distance
  // Distance penalty: stores within 1mi = no penalty, 5mi = moderate, 10mi+ = heavy
  const distPenalty = Math.min(closestDist / 10, 1); // 0..1
  return baseScore * (1 - distanceWeight * distPenalty);
}

// ─── Find best store for food considering distance ─────────────────
function findBestStore(food, preferredStores, nearbyStores, distanceWeight = 0.3) {
  let bestPrice = Infinity;
  let bestStore = null;
  let bestScore = -Infinity;

  for (const [store, price] of Object.entries(food.prices)) {
    if (price === null) continue;
    if (preferredStores && !preferredStores.includes(store)) continue;

    let score = 1 / price; // inverse price (cheaper = higher score)

    if (nearbyStores && nearbyStores.length > 0) {
      const matchingStores = nearbyStores.filter(s => s.type === store);
      if (matchingStores.length > 0) {
        const dist = matchingStores[0].distance;
        const distBonus = 1 - Math.min(dist / 10, 1) * distanceWeight;
        score *= (1 + distBonus);
      } else {
        score *= (1 - distanceWeight * 0.8); // not nearby at all
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestPrice = price;
      bestStore = store;
    }
  }

  return { bestPrice, bestStore };
}

// ─── Nutrition Optimizer (Budget Meal Plan) ────────────────────────
function optimizeMealPlan(budget = 20, days = 3, preferences = {}) {
  const {
    campFriendlyOnly = false, shelfStableOnly = false,
    preferredStores = null, randomize = false,
    nearbyStores = null,
  } = preferences;

  let foods = [...BUDGET_FOODS];

  // Apply filters
  if (campFriendlyOnly) foods = foods.filter(f => f.campFriendly >= 4);
  if (shelfStableOnly) foods = foods.filter(f => f.shelfStable);

  // For each food, find best available store (considering distance)
  const scoredFoods = foods.map(food => {
    const { bestPrice, bestStore } = findBestStore(food, preferredStores, nearbyStores);
    if (!bestStore) return null;

    const cheapestPrice = bestPrice;
    const cheapestStore = bestStore;
    const costPerServing = cheapestPrice / food.servings;
    const caloriesPerDollar = (food.calories * food.servings) / cheapestPrice;
    const proteinPerDollar = (food.proteinG * food.servings) / cheapestPrice;

    return {
      ...food,
      cheapestPrice,
      cheapestStore,
      costPerServing,
      caloriesPerDollar,
      proteinPerDollar,
      distScore: scoreFood({ ...food, cheapestStore, caloriesPerDollar }, nearbyStores),
      meals: MEAL_TAGS[food.id] || ['lunch', 'dinner'],
    };
  }).filter(Boolean);

  // Greedy optimization: cover all food groups at minimum cost
  const plan = [];
  const coveredGroups = {};
  let totalCost = 0;
  let totalCalories = 0;
  let totalProtein = 0;

  // First pass: one item from each food group to ensure coverage
  for (const group of Object.keys(FOOD_GROUPS)) {
    let groupFoods = scoredFoods
      .filter(f => f.group === group && !plan.some(p => p.id === f.id));

    if (randomize) {
      // Shuffle then pick from top-3 cheapest randomly
      groupFoods.sort((a, b) => a.costPerServing - b.costPerServing);
      const topN = groupFoods.slice(0, Math.min(3, groupFoods.length));
      groupFoods = shuffle(topN);
    } else {
      groupFoods.sort((a, b) => a.costPerServing - b.costPerServing);
    }

    if (groupFoods.length > 0 && totalCost + groupFoods[0].cheapestPrice <= budget) {
      const pick = groupFoods[0];
      plan.push({
        ...pick,
        quantity: 1,
        dailyServings: Math.ceil(pick.servings / days),
      });
      totalCost += pick.cheapestPrice;
      totalCalories += pick.calories * pick.servings;
      totalProtein += pick.proteinG * pick.servings;
      coveredGroups[group] = true;
    }
  }

  // Second pass: fill remaining budget with best-scoring items
  let remaining = scoredFoods
    .filter(f => !plan.some(p => p.id === f.id));

  if (randomize) {
    // Sort by distance-weighted score, then shuffle top candidates
    remaining.sort((a, b) => b.distScore - a.distScore);
    const topHalf = remaining.slice(0, Math.ceil(remaining.length * 0.6));
    const bottomHalf = remaining.slice(Math.ceil(remaining.length * 0.6));
    remaining = [...shuffle(topHalf), ...bottomHalf];
  } else {
    remaining.sort((a, b) => b.distScore - a.distScore);
  }

  for (const food of remaining) {
    if (totalCost + food.cheapestPrice > budget) continue;
    plan.push({
      ...food,
      quantity: 1,
      dailyServings: Math.ceil(food.servings / days),
    });
    totalCost += food.cheapestPrice;
    totalCalories += food.calories * food.servings;
    totalProtein += food.proteinG * food.servings;
    coveredGroups[food.group] = true;
  }

  // Build meal plan structure (Breakfast / Lunch / Dinner / Snacks)
  const mealPlan = { breakfast: [], lunch: [], dinner: [], snack: [] };
  for (const item of plan) {
    const meals = item.meals || ['lunch', 'dinner'];
    // Assign to the meal with fewest items so far (balance it out)
    const bestMeal = meals.reduce((best, m) => {
      if (!mealPlan[m]) return best;
      return (mealPlan[m].length < mealPlan[best].length) ? m : best;
    }, meals[0]);
    if (mealPlan[bestMeal]) {
      mealPlan[bestMeal].push(item);
    }
  }

  // Compute coverage
  const groupCoverage = {};
  for (const group of Object.keys(FOOD_GROUPS)) {
    const groupItems = plan.filter(p => p.group === group);
    groupCoverage[group] = {
      ...FOOD_GROUPS[group],
      covered: groupItems.length > 0,
      items: groupItems.length,
      totalCost: groupItems.reduce((sum, p) => sum + p.cheapestPrice, 0),
    };
  }

  // Store breakdown with distance info
  const storeBreakdown = {};
  for (const item of plan) {
    if (!storeBreakdown[item.cheapestStore]) {
      storeBreakdown[item.cheapestStore] = { items: 0, cost: 0, distance: null };
    }
    storeBreakdown[item.cheapestStore].items++;
    storeBreakdown[item.cheapestStore].cost += item.cheapestPrice;
  }
  // Add distance from nearbyStores
  if (nearbyStores) {
    for (const store of Object.keys(storeBreakdown)) {
      const match = nearbyStores.find(s => s.type === store);
      if (match) storeBreakdown[store].distance = match.distance;
    }
  }

  return {
    plan,
    mealPlan,
    totalCost: Math.round(totalCost * 100) / 100,
    totalCalories,
    totalProtein,
    caloriesPerDay: Math.round(totalCalories / days),
    proteinPerDay: Math.round(totalProtein / days),
    daysPlanned: days,
    budget,
    remainingBudget: Math.round((budget - totalCost) * 100) / 100,
    groupCoverage,
    storeBreakdown,
    coveredGroupCount: Object.values(coveredGroups).filter(Boolean).length,
    totalGroups: Object.keys(FOOD_GROUPS).length,
    usedNearbyStores: !!nearbyStores,
  };
}

// ─── Get All Foods with Cross-Store Pricing ────────────────────────
function getAllFoods(filters = {}) {
  let foods = [...BUDGET_FOODS];

  if (filters.group) foods = foods.filter(f => f.group === filters.group);
  if (filters.campFriendly) foods = foods.filter(f => f.campFriendly >= 4);
  if (filters.shelfStable) foods = foods.filter(f => f.shelfStable);
  if (filters.search) {
    const q = filters.search.toLowerCase();
    foods = foods.filter(f => f.name.toLowerCase().includes(q) || f.tags.some(t => t.includes(q)));
  }

  return foods.map(food => {
    let cheapestPrice = Infinity;
    let cheapestStore = null;
    const storeComparisons = [];

    for (const [store, price] of Object.entries(food.prices)) {
      if (price === null) continue;
      storeComparisons.push({ store, storeName: STORES[store].name, price, color: STORES[store].color });
      if (price < cheapestPrice) {
        cheapestPrice = price;
        cheapestStore = store;
      }
    }

    storeComparisons.sort((a, b) => a.price - b.price);
    const savings = storeComparisons.length > 1 ? storeComparisons[storeComparisons.length - 1].price - storeComparisons[0].price : 0;

    return {
      ...food,
      cheapestPrice,
      cheapestStore,
      cheapestStoreName: STORES[cheapestStore]?.name,
      storeComparisons,
      savings: Math.round(savings * 100) / 100,
      costPerServing: Math.round((cheapestPrice / food.servings) * 100) / 100,
      caloriesPerDollar: Math.round((food.calories * food.servings) / cheapestPrice),
    };
  });
}



// ─── Exports ───────────────────────────────────────────────────────
module.exports = {
  STORES,
  FOOD_GROUPS,
  FOOD_BANK_TYPES,
  BUDGET_FOODS,
  findNearbyStores,
  findFoodBanks,
  scrapeWalmartPrices,
  getNutritionData,
  optimizeMealPlan,
  getAllFoods,
};
