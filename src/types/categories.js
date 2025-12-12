/**
 * Category and category tree domain types for creator-scoped APIs.
 *
 * These are runtime-light JS definitions with JSDoc so they can be reused
 * across services, HTTP handlers, and (later) LLM tools without requiring
 * a TS build step.
 */

/**
 * @typedef {Object} Category
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {string|null|undefined} [parentId]
 * @property {number} level
 * @property {string|undefined} [imageUrl]
 * @property {number} productCount
 * @property {string[]} path
 * @property {string[]|undefined} [externalKeys]
 * @property {string[]|undefined} [deals]
 * @property {number|undefined} [priority]
 * @property {string|undefined} [seoDescription]
 */

/**
 * @typedef {Object} CategoryNode
 * @property {Category} category
 * @property {CategoryNode[]} children
 */

/**
 * @typedef {'FLASH_SALE' | 'MULTI_BUY_DISCOUNT'} CategoryDealType
 */

/**
 * @typedef {Object} CategoryDealSummary
 * @property {string} id
 * @property {string} label
 * @property {CategoryDealType} type
 * @property {string[]|undefined} [categoryIds]
 */

/**
 * @typedef {Object} CreatorCategoryTreeResponse
 * @property {string} creatorId
 * @property {CategoryNode[]} roots
 * @property {CategoryDealSummary[]|undefined} [hotDeals]
 */

module.exports = {
  // Types are documented via JSDoc; there is no runtime shape export needed.
};

