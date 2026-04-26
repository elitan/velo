import type { Branch, Project } from '../types/state';
import type { OperationRunner } from '../utils/operation-runner';
import type { ResourceService } from './resource-service';
import type { CertManager } from '../managers/cert';

interface BranchDeleteState {
  snapshots: {
    deleteForBranch(branchName: string): Promise<void>;
  };
  branches: {
    delete(projectId: string, branchId: string): Promise<void>;
  };
}

interface ProjectDeleteState extends BranchDeleteState {
  projects: {
    delete(projectName: string): Promise<void>;
  };
}

type DeleteResources = Pick<
  ResourceService,
  'stopAndRemoveBranchContainer' | 'deleteBranchWalArchive' | 'destroyBranchDataset'
>;

export interface DeleteBranchesOptions {
  operation: OperationRunner;
  branches: Branch[];
  projectId: string;
  state: BranchDeleteState;
  resources: DeleteResources;
}

export interface DeleteProjectOptions {
  operation: OperationRunner;
  project: Project;
  state: ProjectDeleteState;
  resources: DeleteResources;
  cert: Pick<CertManager, 'deleteCerts'>;
}

export async function deleteBranches(options: DeleteBranchesOptions): Promise<void> {
  const { operation, branches, projectId, state, resources } = options;

  await Promise.all(
    branches.map(async function stopBranchContainer(branch) {
      await operation.step(`Stop container: ${branch.name}`, async function stopContainer() {
        await resources.stopAndRemoveBranchContainer(branch);
      });
    })
  );

  await Promise.all(
    branches.map(async function deleteWalArchive(branch) {
      await operation.step(`Clean up WAL archive: ${branch.name}`, async function cleanWalArchive() {
        await resources.deleteBranchWalArchive(branch);
      });
    })
  );

  await Promise.all(
    branches.map(async function deleteSnapshots(branch) {
      await operation.step(`Clean up snapshots: ${branch.name}`, async function cleanSnapshots() {
        await state.snapshots.deleteForBranch(branch.name);
      });
    })
  );

  for (const branch of branches) {
    await operation.step(`Destroy dataset: ${branch.name}`, async function destroyDataset() {
      await resources.destroyBranchDataset(branch);
    });
  }

  await Promise.all(
    branches.map(async function deleteBranchState(branch) {
      await operation.step(`Remove branch state: ${branch.name}`, async function removeBranchState() {
        await state.branches.delete(projectId, branch.id);
      });
    })
  );
}

export async function deleteProject(options: DeleteProjectOptions): Promise<void> {
  const { operation, project, state, resources, cert } = options;
  const branches = [...project.branches].reverse();

  await Promise.all(
    branches.map(async function stopBranchContainer(branch) {
      await operation.step(`Remove branch: ${branch.name}`, async function stopContainer() {
        await resources.stopAndRemoveBranchContainer(branch);
      });
    })
  );

  await operation.step('Destroy ZFS datasets', async function destroyDatasets() {
    for (const branch of branches) {
      await resources.destroyBranchDataset(branch);
    }
  });

  await operation.step('Clean up WAL archives', async function deleteWalArchives() {
    await Promise.all(
      branches.map(async function deleteWalArchive(branch) {
        await resources.deleteBranchWalArchive(branch);
      })
    );
  });

  await operation.step('Clean up snapshots', async function deleteSnapshots() {
    await Promise.all(
      branches.map(async function deleteBranchSnapshots(branch) {
        await state.snapshots.deleteForBranch(branch.name);
      })
    );
  });

  await operation.step('Clean up SSL certificates', async function deleteCertificates() {
    await cert.deleteCerts(project.name);
  });

  await operation.step('Remove project state', async function deleteProjectState() {
    await state.projects.delete(project.name);
  });
}
