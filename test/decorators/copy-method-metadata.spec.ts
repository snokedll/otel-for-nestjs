import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { copyMethodMetadata } from '../../src/decorators/copy-method-metadata';

describe('copyMethodMetadata', () => {
  it('copies a single metadata entry from source to target', () => {
    const source = function original() {};
    const target = function wrapper() {};
    Reflect.defineMetadata('path', '/invoices/:id', source);

    copyMethodMetadata(source, target);

    expect(Reflect.getMetadata('path', target)).toBe('/invoices/:id');
  });

  it('copies every metadata key present on source', () => {
    const source = function original() {};
    const target = function wrapper() {};
    Reflect.defineMetadata('path', '/invoices', source);
    Reflect.defineMetadata('method', 'GET', source);
    Reflect.defineMetadata('guards', ['AuthGuard'], source);

    copyMethodMetadata(source, target);

    expect(Reflect.getMetadata('path', target)).toBe('/invoices');
    expect(Reflect.getMetadata('method', target)).toBe('GET');
    expect(Reflect.getMetadata('guards', target)).toEqual(['AuthGuard']);
  });

  it('does nothing when source carries no metadata', () => {
    const source = function original() {};
    const target = function wrapper() {};

    expect(() => copyMethodMetadata(source, target)).not.toThrow();
    expect(Reflect.getMetadataKeys(target)).toEqual([]);
  });

  it('does not remove metadata already present on target', () => {
    const source = function original() {};
    const target = function wrapper() {};
    Reflect.defineMetadata('path', '/from-source', source);
    Reflect.defineMetadata('ownMetadata', 'kept', target);

    copyMethodMetadata(source, target);

    expect(Reflect.getMetadata('ownMetadata', target)).toBe('kept');
    expect(Reflect.getMetadata('path', target)).toBe('/from-source');
  });
});
