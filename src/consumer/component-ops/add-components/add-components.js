/** @flow */
import path from 'path';
import fs from 'fs-extra';
import R from 'ramda';
import format from 'string-format';
import assignwith from 'lodash.assignwith';
import groupby from 'lodash.groupby';
import unionBy from 'lodash.unionby';
import ignore from 'ignore';
import arrayDiff from 'array-difference';
import { Analytics } from '../../../analytics/analytics';
import {
  glob,
  isDir,
  calculateFileInfo,
  pathNormalizeToLinux,
  getMissingTestFiles,
  retrieveIgnoreList,
  pathJoinLinux,
  isAutoGeneratedFile
} from '../../../utils';
import { Consumer } from '../../../consumer';
import BitMap from '../../../consumer/bit-map';
import { BitId } from '../../../bit-id';
import type { BitIdStr } from '../../../bit-id/bit-id';
import { COMPONENT_ORIGINS, DEFAULT_DIST_DIRNAME, VERSION_DELIMITER, PACKAGE_JSON } from '../../../constants';
import logger from '../../../logger/logger';
import {
  PathsNotExist,
  MissingComponentIdForImportedComponent,
  IncorrectIdForImportedComponent,
  NoFiles,
  DuplicateIds,
  EmptyDirectory,
  TestIsDirectory,
  ExcludedMainFile,
  MainFileIsDir
} from './exceptions';
import type { ComponentMapFile, ComponentOrigin } from '../../bit-map/component-map';
import type { PathLinux, PathOsBased } from '../../../utils/path';
import ComponentMap from '../../bit-map/component-map';
import GeneralError from '../../../error/general-error';
import VersionShouldBeRemoved from './exceptions/version-should-be-removed';
import { isSupportedExtension } from '../../../links/link-content';
import MissingMainFile from '../../bit-map/exceptions/missing-main-file';
import MissingMainFileMultipleComponents from './exceptions/missing-main-file-multiple-components';

export type AddResult = { id: string, files: ComponentMapFile[] };
type Warnings = {
  alreadyUsed: Object,
  emptyDirectory: string[]
};
export type AddActionResults = { addedComponents: AddResult[], warnings: Warnings };
export type PathOrDSL = PathOsBased | string; // can be a path or a DSL, e.g: tests/{PARENT}/{FILE_NAME}
type PathsStats = { [PathOsBased]: { isDir: boolean } };
type AddedComponent = {
  componentId: BitId,
  files: ComponentMapFile[],
  mainFile?: ?PathOsBased,
  trackDir?: PathOsBased // set only when one directory is added by author
};
const REGEX_DSL_PATTERN = /{([^}]+)}/g;

export type AddProps = {
  componentPaths: PathOsBased[],
  id?: string,
  main?: PathOsBased,
  namespace?: string,
  skipNamespace: boolean,
  tests?: PathOrDSL[],
  exclude?: PathOrDSL[],
  override: boolean,
  trackDirFeature?: boolean,
  origin?: ComponentOrigin
};
// This is the contxt of the add operation. By default, the add is executed in the same folder in which the consumer is located and it is the process.cwd().
// In that case , give the value false to overridenConsumer .
// There is a possibility to execute add when the process.cwd() is different from the project directory. In that case , when add is done on a folder wchih is
// Different from process.cwd(), transfer true.
// Required for determining if the paths are relative to consumer or to process.cwd().
export type AddContext = {
  consumer: Consumer,
  alternateCwd?: string
};

export default class AddComponents {
  consumer: Consumer;
  bitMap: BitMap;
  componentPaths: PathOsBased[];
  id: ?string; // id entered by the user
  main: ?PathOsBased;
  namespace: ?string;
  skipNamespace: boolean;
  tests: PathOrDSL[];
  exclude: PathOrDSL[];
  override: boolean; // (default = false) replace the files array or only add files.
  trackDirFeature: ?boolean;
  warnings: Warnings;
  ignoreList: string[];
  gitIgnore: any;
  origin: ComponentOrigin;
  alternateCwd: ?string;
  addedComponents: AddResult[];
  constructor(context: AddContext, addProps: AddProps) {
    this.alternateCwd = context.alternateCwd;
    this.consumer = context.consumer;
    this.bitMap = this.consumer.bitMap;
    this.componentPaths = this.joinConsumerPathIfNeeded(addProps.componentPaths);
    this.id = addProps.id;
    this.main = addProps.main;
    this.namespace = addProps.namespace;
    this.skipNamespace = addProps.skipNamespace;
    this.tests = addProps.tests ? this.joinConsumerPathIfNeeded(addProps.tests) : [];
    this.exclude = addProps.exclude ? this.joinConsumerPathIfNeeded(addProps.exclude) : [];
    this.override = addProps.override;
    this.trackDirFeature = addProps.trackDirFeature;
    this.origin = addProps.origin || COMPONENT_ORIGINS.AUTHORED;
    this.warnings = {
      alreadyUsed: {},
      emptyDirectory: []
    };
    this.addedComponents = [];
  }

  joinConsumerPathIfNeeded(paths: PathOrDSL[]): PathOrDSL[] {
    if (paths.length > 0) {
      if (this.alternateCwd !== undefined && this.alternateCwd !== null) {
        const alternate = this.alternateCwd;
        return paths.map(file => path.join(alternate, file));
      }
      return paths;
    }
    return [];
  }

  /**
   * @param {string[]} files - array of file-paths from which it should search for the dsl patterns.
   * @param {*} filesWithPotentialDsl - array of file-path which may have DSL patterns
   *
   * @returns array of file-paths from 'files' parameter that match the patterns from 'filesWithPotentialDsl' parameter
   */
  async getFilesAccordingToDsl(files: string[], filesWithPotentialDsl: PathOrDSL[]): Promise<PathLinux[]> {
    const filesListAllMatches = filesWithPotentialDsl.map(async (dsl) => {
      const filesListMatch = files.map(async (file) => {
        const fileInfo = calculateFileInfo(file);
        const generatedFile = format(dsl, fileInfo);
        const matches = await glob(generatedFile);
        const matchesAfterGitIgnore = this.gitIgnore.filter(matches);
        return matchesAfterGitIgnore.filter(match => fs.existsSync(match));
      });
      return Promise.all(filesListMatch);
    });

    const filesListFlatten = R.flatten(await Promise.all(filesListAllMatches));
    const filesListUnique = R.uniq(filesListFlatten);
    return filesListUnique.map((file) => {
      const relativeToConsumer = this.consumer.getPathRelativeToConsumer(file);
      return pathNormalizeToLinux(relativeToConsumer);
    });
  }

  addToBitMap({ componentId, files, mainFile, trackDir }: AddedComponent): AddResult {
    const getComponentMap = (): ComponentMap => {
      if (this.trackDirFeature) {
        return this.bitMap.addFilesToComponent({ componentId, files });
      }
      return this.bitMap.addComponent({
        componentId,
        files,
        mainFile,
        trackDir,
        origin: COMPONENT_ORIGINS.AUTHORED,
        override: this.override
      });
    };
    const componentMap = getComponentMap();
    return { id: componentId.toString(), files: componentMap.files };
  }

  /**
   * unsupported files, such as, binary files, don't have link-file. instead, they have a symlink
   * inside the component dir, pointing to the dependency.
   * this methods check whether a file is auto generated for the unsupported files.
   */
  async _isGeneratedForUnsupportedFiles(
    fileRelativePath: PathLinux,
    componentId: BitId,
    componentMap: ComponentMap
  ): Promise<boolean> {
    if (isSupportedExtension(fileRelativePath)) return false;
    const componentFromModel = await this.consumer.loadComponentFromModelIfExist(componentId);
    if (!componentFromModel) {
      throw new GeneralError(
        `failed finding ${componentId.toString()} in the model although the component is imported, try running "bit import ${componentId.toString()} --objects" to get the component saved in the model`
      );
    }
    const dependencies = componentFromModel.getAllDependenciesCloned();
    const sourcePaths = dependencies.getSourcesPaths();
    const sourcePathsRelativeToConsumer = sourcePaths.map(sourcePath =>
      pathJoinLinux(componentMap.rootDir, sourcePath)
    );
    return sourcePathsRelativeToConsumer.includes(fileRelativePath);
  }

  /**
   * for imported component, the package.json in the root directory is a bit-generated file and as
   * such, it should be ignored
   */
  _isPackageJsonOnRootDir(pathRelativeToConsumerRoot: PathLinux, componentMap: ComponentMap) {
    if (!componentMap.rootDir || componentMap.origin !== COMPONENT_ORIGINS.IMPORTED) {
      throw new Error('_isPackageJsonOnRootDir should not get called on non imported components');
    }
    return path.join(componentMap.rootDir, PACKAGE_JSON) === path.normalize(pathRelativeToConsumerRoot);
  }

  /**
   * imported components might have wrapDir, when they do, files should not be added outside of
   * that wrapDir
   */
  _isOutsideOfWrapDir(pathRelativeToConsumerRoot: PathLinux, componentMap: ComponentMap) {
    if (!componentMap.rootDir || componentMap.origin !== COMPONENT_ORIGINS.IMPORTED) {
      throw new Error('_isOutsideOfWrapDir should not get called on non imported components');
    }
    if (!componentMap.wrapDir) return false;
    const wrapDirRelativeToConsumerRoot = path.join(componentMap.rootDir, componentMap.wrapDir);
    return !path.normalize(pathRelativeToConsumerRoot).startsWith(wrapDirRelativeToConsumerRoot);
  }

  /**
   * Add or update existing (imported and new) component according to bitmap
   * there are 3 options:
   * 1. a user is adding a new component. there is no record for this component in bit.map
   * 2. a user is updating an existing component. there is a record for this component in bit.map
   * 3. some or all the files of this component were previously added as another component-id.
   */
  async addOrUpdateComponentInBitMap(component: AddedComponent): Promise<?AddResult> {
    const consumerPath = this.consumer.getPath();
    const parsedBitId = component.componentId;
    const files: ComponentMapFile[] = component.files;
    const foundComponentFromBitMap = this.bitMap.getComponentIfExist(component.componentId, {
      ignoreScopeAndVersion: true
    });
    const componentFilesP = files.map(async (file: ComponentMapFile) => {
      // $FlowFixMe null is removed later on
      const filePath = path.join(consumerPath, file.relativePath);
      const isAutoGenerated = await isAutoGeneratedFile(filePath);
      if (isAutoGenerated) {
        return null;
      }
      const caseSensitive = false;
      const existingIdOfFile = this.bitMap.getComponentIdByPath(file.relativePath, caseSensitive);
      const idOfFileIsDifferent = existingIdOfFile && !existingIdOfFile.isEqual(parsedBitId);
      const existingComponentOfFile = existingIdOfFile ? this.bitMap.getComponent(existingIdOfFile) : undefined;
      const isImported =
        (foundComponentFromBitMap && foundComponentFromBitMap.origin === COMPONENT_ORIGINS.IMPORTED) ||
        (existingComponentOfFile && existingComponentOfFile.origin === COMPONENT_ORIGINS.IMPORTED);
      if (isImported) {
        // throw error in case user didn't add id to imported component or the id is incorrect
        if (!this.id) throw new MissingComponentIdForImportedComponent(parsedBitId.toStringWithoutVersion());
        if (idOfFileIsDifferent) {
          const existingIdWithoutVersion = existingIdOfFile.toStringWithoutVersion();
          // $FlowFixMe $this.id is not null at this point
          throw new IncorrectIdForImportedComponent(existingIdWithoutVersion, this.id, file.relativePath);
        }
        if (this._isPackageJsonOnRootDir(file.relativePath, foundComponentFromBitMap)) return null;
        if (this._isOutsideOfWrapDir(file.relativePath, foundComponentFromBitMap)) {
          logger.warn(`add-components: ignoring ${file.relativePath} as it is located outside of the wrapDir`);
          return null;
        }
        const isGeneratedForUnsupportedFiles = await this._isGeneratedForUnsupportedFiles(
          file.relativePath,
          component.componentId,
          foundComponentFromBitMap
        );
        if (isGeneratedForUnsupportedFiles) return null;
        delete component.trackDir;
      } else if (idOfFileIsDifferent) {
        // not imported component file but exists in bitmap
        if (this.warnings.alreadyUsed[existingIdOfFile]) {
          this.warnings.alreadyUsed[existingIdOfFile].push(file.relativePath);
        } else {
          this.warnings.alreadyUsed[existingIdOfFile] = [file.relativePath];
        }
        // $FlowFixMe null is removed later on
        return null;
      }
      return file;
    });
    const componentFiles = (await Promise.all(componentFilesP)).filter(file => file);
    if (!componentFiles.length) return { id: component.componentId.toString(), files: [] };
    // $FlowFixMe it can't be null due to the filter function
    component.files = componentFiles;
    return this.addToBitMap(component);
  }

  // remove excluded files from file list
  async removeExcludedFiles(componentsWithFiles: AddedComponent[]) {
    const files = R.flatten(componentsWithFiles.map(x => x.files.map(i => i.relativePath)));
    const resolvedExcludedFiles = await this.getFilesAccordingToDsl(files, this.exclude);
    componentsWithFiles.forEach((componentWithFiles: AddedComponent) => {
      const mainFile = componentWithFiles.mainFile ? pathNormalizeToLinux(componentWithFiles.mainFile) : undefined;
      if (resolvedExcludedFiles.includes(mainFile)) {
        componentWithFiles.files = [];
      } else {
        // if mainFile is excluded, exclude all files
        componentWithFiles.files = componentWithFiles.files.filter(
          key => !resolvedExcludedFiles.includes(key.relativePath)
        );
      }
    });
  }

  /**
   * if the id is already saved in bitmap file, it might have more data (such as scope, version)
   * use that id instead.
   */
  _getIdAccordingToExistingComponent(currentId: BitIdStr): BitId {
    const existingComponentId = this.bitMap.getExistingBitId(currentId, false);
    const componentExists = Boolean(existingComponentId);
    if (componentExists && this.bitMap.getComponent(existingComponentId).origin === COMPONENT_ORIGINS.NESTED) {
      throw new GeneralError(`One of your dependencies (${existingComponentId}) has already the same namespace and name.
    If you're trying to add a new component, please choose a new namespace or name.
    If you're trying to update a dependency component, please re-import it individually`);
    }
    if (currentId.includes(VERSION_DELIMITER)) {
      if (
        !existingComponentId || // this id is new, it shouldn't have a version
        !existingComponentId.hasVersion() || // this component is new, it shouldn't have a version
        // user shouldn't add files to a an existing component with different version
        // $FlowFixMe this function gets called only when this.id is set
        existingComponentId.version !== BitId.getVersionOnlyFromString(this.id)
      ) {
        // $FlowFixMe this.id is defined here
        throw new VersionShouldBeRemoved(this.id);
      }
    }
    return existingComponentId || BitId.parse(currentId, false);
  }

  /**
   * used for updating main file if exists or doesn't exists
   */
  _addMainFileToFiles(files: ComponentMapFile[]): ?PathOsBased {
    let mainFile = this.main;
    if (mainFile && mainFile.match(REGEX_DSL_PATTERN)) {
      // it's a DSL
      files.forEach((file) => {
        const fileInfo = calculateFileInfo(file.relativePath);
        const generatedFile = format(mainFile, fileInfo);
        const foundFile = R.find(R.propEq('relativePath', pathNormalizeToLinux(generatedFile)))(files);
        if (foundFile) {
          mainFile = foundFile.relativePath;
        }
        if (fs.existsSync(generatedFile) && !foundFile) {
          const shouldIgnore = this.gitIgnore.ignores(generatedFile);
          if (shouldIgnore) {
            // check if file is in exclude list
            throw new ExcludedMainFile(generatedFile);
          }
          files.push({
            relativePath: pathNormalizeToLinux(generatedFile),
            test: false,
            name: path.basename(generatedFile)
          });
          mainFile = generatedFile;
        }
      });
    }
    if (!mainFile) return undefined;
    if (this.alternateCwd) {
      mainFile = path.join(this.alternateCwd, mainFile);
    }
    const mainFileRelativeToConsumer = this.consumer.getPathRelativeToConsumer(mainFile);
    const mainPath = this.consumer.toAbsolutePath(mainFileRelativeToConsumer);
    if (fs.existsSync(mainPath)) {
      const shouldIgnore = this.gitIgnore.ignores(mainFileRelativeToConsumer);
      if (shouldIgnore) throw new ExcludedMainFile(mainFileRelativeToConsumer);
      if (isDir(mainPath)) {
        throw new MainFileIsDir(mainPath);
      }
      const foundFile = R.find(R.propEq('relativePath', pathNormalizeToLinux(mainFileRelativeToConsumer)))(files);
      if (!foundFile) {
        files.push({
          relativePath: pathNormalizeToLinux(mainFileRelativeToConsumer),
          test: false,
          name: path.basename(mainFileRelativeToConsumer)
        });
      }
      return mainFileRelativeToConsumer;
    }
    return mainFile;
  }

  async _mergeTestFilesWithFiles(files: ComponentMapFile[]): Promise<ComponentMapFile[]> {
    const testFiles = !R.isEmpty(this.tests)
      ? await this.getFilesAccordingToDsl(files.map(file => file.relativePath), this.tests)
      : [];

    const resolvedTestFiles = testFiles.map((testFile) => {
      if (isDir(path.join(this.consumer.getPath(), testFile))) throw new TestIsDirectory(testFile);
      return {
        relativePath: testFile,
        test: true,
        name: path.basename(testFile)
      };
    });

    return unionBy(resolvedTestFiles, files, 'relativePath');
  }

  /**
   * given the component paths, prepare the id, mainFile and files to be added later on to bitmap
   * the id of the component is either entered by the user or, if not entered, concluded by the path.
   * e.g. bar/foo.js, the id would be bar/foo.
   * in case bitmap has already the same id, the complete id is taken from bitmap (see _getIdAccordingToExistingComponent)
   */
  async addOneComponent(componentPathsStats: PathsStats): Promise<AddedComponent> {
    let finalBitId: BitId; // final id to use for bitmap file
    if (this.id) {
      finalBitId = this._getIdAccordingToExistingComponent(this.id);
    }

    const componentsWithFilesP = Object.keys(componentPathsStats).map(async (componentPath) => {
      if (componentPathsStats[componentPath].isDir) {
        const relativeComponentPath = this.consumer.getPathRelativeToConsumer(componentPath);

        const matches = await glob(path.join(relativeComponentPath, '**'), {
          cwd: this.consumer.getPath(),
          nodir: true
        });

        const filteredMatches = this.gitIgnore.filter(matches);

        if (!filteredMatches.length) throw new EmptyDirectory();

        let filteredMatchedFiles = filteredMatches.map((match: PathOsBased) => {
          return { relativePath: pathNormalizeToLinux(match), test: false, name: path.basename(match) };
        });

        // merge test files with files
        filteredMatchedFiles = await this._mergeTestFilesWithFiles(filteredMatchedFiles);
        const resolvedMainFile = this._addMainFileToFiles(filteredMatchedFiles);

        if (!finalBitId) {
          const absoluteComponentPath = path.resolve(componentPath);
          const splitPath = absoluteComponentPath.split(path.sep);
          const lastDir = splitPath[splitPath.length - 1];
          const nameSpaceOrDir = this.namespace || splitPath[splitPath.length - 2];
          const idFromPath = BitId.getValidBitId(this.skipNamespace ? undefined : nameSpaceOrDir, lastDir);
          finalBitId = this._getIdAccordingToExistingComponent(idFromPath.toString());
        }

        const trackDir =
          Object.keys(componentPathsStats).length === 1 &&
          !this.exclude.length &&
          this.origin === COMPONENT_ORIGINS.AUTHORED
            ? relativeComponentPath
            : undefined;

        return { componentId: finalBitId, files: filteredMatchedFiles, mainFile: resolvedMainFile, trackDir };
      }
      // is file
      const absolutePath = path.resolve(componentPath);
      const pathParsed = path.parse(absolutePath);
      const relativeFilePath = this.consumer.getPathRelativeToConsumer(componentPath);
      if (!finalBitId) {
        let dirName = pathParsed.dir;
        if (!dirName) {
          dirName = path.dirname(absolutePath);
        }
        const nameSpaceOrLastDir = this.namespace || R.last(dirName.split(path.sep));
        const idFromPath = BitId.getValidBitId(this.skipNamespace ? undefined : nameSpaceOrLastDir, pathParsed.name);
        finalBitId = this._getIdAccordingToExistingComponent(idFromPath.toString());
      }

      let files = [
        { relativePath: pathNormalizeToLinux(relativeFilePath), test: false, name: path.basename(relativeFilePath) }
      ];

      files = await this._mergeTestFilesWithFiles(files);
      const resolvedMainFile = this._addMainFileToFiles(files);
      return { componentId: finalBitId, files, mainFile: resolvedMainFile };
    });

    let componentsWithFiles: AddedComponent[] = await Promise.all(componentsWithFilesP);

    // remove files that are excluded
    if (!R.isEmpty(this.exclude)) await this.removeExcludedFiles(componentsWithFiles);

    const componentId = finalBitId;
    componentsWithFiles = componentsWithFiles.filter(componentWithFiles => componentWithFiles.files.length);

    // $FlowFixMe
    if (componentsWithFiles.length === 0) return { componentId, files: [] };
    if (componentsWithFiles.length === 1) return componentsWithFiles[0];

    const files = componentsWithFiles.reduce((a, b) => {
      return a.concat(b.files);
    }, []);
    const groupedComponents = groupby(files, 'relativePath');
    const uniqComponents = Object.keys(groupedComponents).map(key =>
      assignwith({}, ...groupedComponents[key], (val1, val2) => val1 || val2)
    );
    // $FlowFixMe
    return {
      componentId,
      files: uniqComponents,
      mainFile: R.head(componentsWithFiles).mainFile,
      trackDir: R.head(componentsWithFiles).trackDir
    };
  }

  getIgnoreList(): string[] {
    const consumerPath = this.consumer.getPath();
    let ignoreList = retrieveIgnoreList(consumerPath);
    const importedComponents = this.bitMap.getAllComponents(COMPONENT_ORIGINS.IMPORTED);
    const distDirsOfImportedComponents = Object.keys(importedComponents).map(key =>
      pathJoinLinux(importedComponents[key].rootDir, DEFAULT_DIST_DIRNAME, '**')
    );
    const configsToIgnore = this.bitMap.getConfigDirsAndFilesToIgnore(this.consumer.getPath());
    const configDirs = configsToIgnore.dirs.map(dir => pathJoinLinux(dir, '**'));
    ignoreList = ignoreList.concat(distDirsOfImportedComponents);
    ignoreList = ignoreList.concat(configsToIgnore.files);
    ignoreList = ignoreList.concat(configDirs);
    return ignoreList;
  }

  async add(): Promise<AddActionResults> {
    this.ignoreList = this.getIgnoreList();
    this.gitIgnore = ignore().add(this.ignoreList); // add ignore list

    // check unknown test files
    const missingFiles = getMissingTestFiles(this.tests);
    if (!R.isEmpty(missingFiles)) {
      throw new PathsNotExist(missingFiles);
    }
    let componentPathsStats = {};

    const resolvedComponentPathsWithoutGitIgnore = R.flatten(
      await Promise.all(this.componentPaths.map(componentPath => glob(componentPath)))
    );

    /** add excluded list to gitignore to remove excluded files from list */
    const resolvedExcludedFiles = await this.getFilesAccordingToDsl(
      resolvedComponentPathsWithoutGitIgnore,
      this.exclude
    );
    this.ignoreList = [...this.ignoreList, ...resolvedExcludedFiles];
    this.gitIgnore = ignore().add(this.ignoreList); // add ignore list

    const resolvedComponentPathsWithGitIgnore = this.gitIgnore.filter(resolvedComponentPathsWithoutGitIgnore);
    // Run diff on both arrays to see what was filtered out because of the gitignore file
    const diff = arrayDiff(resolvedComponentPathsWithGitIgnore, resolvedComponentPathsWithoutGitIgnore);

    if (!R.isEmpty(this.tests) && this.id && R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) {
      const resolvedTestFiles = R.flatten(await Promise.all(this.tests.map(componentPath => glob(componentPath))));
      componentPathsStats = validatePaths(resolvedTestFiles);
    } else {
      if (R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) {
        throw new PathsNotExist(this.componentPaths);
      }
      if (!R.isEmpty(resolvedComponentPathsWithGitIgnore)) {
        componentPathsStats = validatePaths(resolvedComponentPathsWithGitIgnore);
      } else {
        throw new NoFiles(diff);
      }
    }
    // if a user entered multiple paths and entered an id, he wants all these paths to be one component
    // conversely, if a user entered multiple paths without id, he wants each dir as an individual component
    const isMultipleComponents = Object.keys(componentPathsStats).length > 1 && !this.id;
    if (isMultipleComponents) {
      await this.addMultipleComponents(componentPathsStats);
    } else {
      logger.debug('bit add - one component');
      // when a user enters more than one directory, he would like to keep the directories names
      // so then when a component is imported, it will write the files into the original directories
      const addedOne = await this.addOneComponent(componentPathsStats);
      if (!R.isEmpty(addedOne.files)) {
        const addedResult = await this.addOrUpdateComponentInBitMap(addedOne);
        if (addedResult) this.addedComponents.push(addedResult);
      }
    }
    Analytics.setExtraData('num_components', this.addedComponents.length);
    return { addedComponents: this.addedComponents, warnings: this.warnings };
  }

  async addMultipleComponents(componentPathsStats: PathsStats): Promise<void> {
    logger.debug('bit add - multiple components');
    const testToRemove = !R.isEmpty(this.tests)
      ? await this.getFilesAccordingToDsl(Object.keys(componentPathsStats), this.tests)
      : [];
    testToRemove.forEach(test => delete componentPathsStats[path.normalize(test)]);
    const added = await this._tryAddingMultiple(componentPathsStats);
    validateNoDuplicateIds(added);
    await this._addMultipleToBitMap(added);
  }

  async _addMultipleToBitMap(added: AddedComponent[]): Promise<void> {
    const missingMainFiles = [];
    await Promise.all(
      added.map(async (component) => {
        if (!R.isEmpty(component.files)) {
          try {
            const addedComponent = await this.addOrUpdateComponentInBitMap(component);
            if (addedComponent && addedComponent.files.length) this.addedComponents.push(addedComponent);
          } catch (err) {
            if (!(err instanceof MissingMainFile)) throw err;
            missingMainFiles.push(err);
          }
        }
      })
    );
    if (missingMainFiles.length) {
      throw new MissingMainFileMultipleComponents(missingMainFiles.map(err => err.componentId).sort());
    }
  }

  async _tryAddingMultiple(componentPathsStats: PathsStats): Promise<AddedComponent[]> {
    const addedP = Object.keys(componentPathsStats).map(async (onePath) => {
      const oneComponentPathStat = { [onePath]: componentPathsStats[onePath] };
      try {
        const addedComponent = await this.addOneComponent(oneComponentPathStat);
        return addedComponent;
      } catch (err) {
        if (!(err instanceof EmptyDirectory)) throw err;
        this.warnings.emptyDirectory.push(onePath);
        return null;
      }
    });
    const added = await Promise.all(addedP);
    return R.reject(R.isNil, added);
  }
}

/**
 * validatePaths - validate if paths entered by user exist and if not throw an error
 *
 * @param {string[]} fileArray - array of paths
 * @returns {PathsStats} componentPathsStats
 */
function validatePaths(fileArray: string[]): PathsStats {
  const componentPathsStats = {};
  fileArray.forEach((componentPath) => {
    if (!fs.existsSync(componentPath)) {
      throw new PathsNotExist([componentPath]);
    }
    componentPathsStats[componentPath] = {
      isDir: isDir(componentPath)
    };
  });
  return componentPathsStats;
}

/**
 * validate that no two files where added with the same id in the same bit add command
 */
function validateNoDuplicateIds(addComponents: Object[]) {
  const duplicateIds = {};
  const newGroupedComponents = groupby(addComponents, 'componentId');
  Object.keys(newGroupedComponents).forEach((key) => {
    if (newGroupedComponents[key].length > 1) duplicateIds[key] = newGroupedComponents[key];
  });
  if (!R.isEmpty(duplicateIds) && !R.isNil(duplicateIds)) throw new DuplicateIds(duplicateIds);
}
