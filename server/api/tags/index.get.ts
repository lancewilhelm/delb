import { listEntities } from '~~/server/utils/books/entity-list';

export default defineEventHandler((event) => listEntities(event, 'tags'));
