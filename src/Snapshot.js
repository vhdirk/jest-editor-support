/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

import traverse from '@babel/traverse';
import {buildSnapshotResolver, SnapshotResolver, utils} from 'jest-snapshot';
import type {ProjectConfig} from '../types/Config';

import {getASTfor} from './parsers/babel_parser';

type Node = any;

type SnapshotMetadata = {
  exists: true | false,
  name: string,
  node: Node,
  content?: string,
};

const describeVariants = Object.assign((Object.create(null): {[string]: boolean, __proto__: null}), {
  describe: true,
  fdescribe: true,
  xdescribe: true,
});
const base = Object.assign((Object.create(null): {[string]: boolean, __proto__: null}), {
  describe: true,
  it: true,
  test: true,
});
const decorators = Object.assign((Object.create(null): {[string]: boolean, __proto__: null}), {
  only: true,
  skip: true,
});

const validParents = Object.assign(
  (Object.create(null): any),
  base,
  describeVariants,
  Object.assign((Object.create(null): {[string]: boolean, __proto__: null}), {
    fit: true,
    xit: true,
    xtest: true,
  })
);

const isValidMemberExpression = (node) =>
  node.object && base[node.object.name] && node.property && decorators[node.property.name];

const isDescribe = (node) =>
  describeVariants[node.name] || (isValidMemberExpression(node) && node.object.name === 'describe');

const isValidParent = (parent) =>
  parent.callee && (validParents[parent.callee.name] || isValidMemberExpression(parent.callee));

const getArrayOfParents = (path) => {
  const result = [];
  let parent = path.parentPath;
  while (parent) {
    result.unshift(parent.node);
    parent = parent.parentPath;
  }
  return result;
};

const buildName: (snapshotNode: Node, parents: Array<Node>, position: number) => string = (
  snapshotNode,
  parents,
  position
) => {
  const fullName = parents.map((parent) => parent.arguments[0].value).join(' ');

  return utils.testNameToKey(fullName, position);
};

export default class Snapshot {
  _parser: Function;

  _matchers: Array<string>;

  _projectConfig: ?ProjectConfig;

  snapshotResolver: ?SnapshotResolver;

  _resolverPromise: Promise<SnapshotResolver>;

  constructor(parser: any, customMatchers?: Array<string>, projectConfig?: ProjectConfig) {
    this._parser = parser || getASTfor;
    this._matchers = ['toMatchSnapshot', 'toThrowErrorMatchingSnapshot'].concat(customMatchers || []);
    this._projectConfig = projectConfig;
    this._resolverPromise = buildSnapshotResolver(this._projectConfig || {}, () => Promise.resolve()).then(
      (resolver) => {
        this.snapshotResolver = resolver;
      }
    );
  }

  async getMetadataAsync(filePath: string, verbose: boolean = false): Promise<Array<SnapshotMetadata>> {
    if (!this.snapshotResolver) {
      await this._resolverPromise;
    }
    return this.getMetadata(filePath, verbose);
  }

  getMetadata(filePath: string, verbose: boolean = false): Array<SnapshotMetadata> {
    if (!this.snapshotResolver) {
      throw new Error('snapshotResolver is not ready yet, consider migrating to "getMetadataAsync" instead');
    }
    const snapshotPath = this.snapshotResolver.resolveSnapshotPath(filePath);

    let fileNode;
    try {
      fileNode = this._parser(filePath);
    } catch (error) {
      if (verbose) {
        // eslint-disable-next-line no-console
        console.warn(error);
      }
      return [];
    }
    const state = {
      found: [],
    };
    const Visitors = {
      Identifier(path, _state, matchers) {
        if (matchers.indexOf(path.node.name) >= 0) {
          _state.found.push({
            node: path.node,
            parents: getArrayOfParents(path),
          });
        }
      },
    };

    traverse(fileNode, {
      enter: (path) => {
        const visitor = Visitors[path.node.type];
        if (visitor != null) {
          visitor(path, state, this._matchers);
        }
      },
    });

    // NOTE if no projectConfig is given the default resolver will be used

    const snapshots = utils.getSnapshotData(snapshotPath, 'none').data;
    let lastParent = null;
    let count = 1;

    return state.found.map((snapshotNode) => {
      const parents = snapshotNode.parents.filter(isValidParent);
      const innerAssertion = parents[parents.length - 1];

      if (lastParent !== innerAssertion) {
        lastParent = innerAssertion;
        count = 1;
      }

      const result = {
        content: undefined,
        count,
        exists: false,
        name: '',
        node: snapshotNode.node,
      };
      count += 1;

      if (!innerAssertion || isDescribe(innerAssertion.callee)) {
        // An expectation inside describe never gets executed.
        return result;
      }

      result.name = buildName(snapshotNode, parents, result.count);

      if (snapshots[result.name]) {
        result.exists = true;
        result.content = snapshots[result.name];
      }
      return result;
    });
  }
}
