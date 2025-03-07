/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { DirtyDiffWorkbenchController } from './dirtydiffDecorator';
import { VIEWLET_ID, ISCMService, VIEW_PANE_ID, ISCMProvider, ISCMViewService, REPOSITORIES_VIEW_PANE_ID, SYNC_VIEW_PANE_ID } from 'vs/workbench/contrib/scm/common/scm';
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { MenuRegistry, MenuId } from 'vs/platform/actions/common/actions';
import { SCMActiveResourceContextKeyController, SCMStatusController } from './activity';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';
import { IContextKeyService, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { CommandsRegistry, ICommandService } from 'vs/platform/commands/common/commands';
import { KeybindingsRegistry, KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { SCMService } from 'vs/workbench/contrib/scm/common/scmService';
import { IViewContainersRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, IViewsRegistry } from 'vs/workbench/common/views';
import { SCMViewPaneContainer } from 'vs/workbench/contrib/scm/browser/scmViewPaneContainer';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { ModesRegistry } from 'vs/editor/common/languages/modesRegistry';
import { Codicon } from 'vs/base/common/codicons';
import { registerIcon } from 'vs/platform/theme/common/iconRegistry';
import { SCMViewPane } from 'vs/workbench/contrib/scm/browser/scmViewPane';
import { SCMViewService } from 'vs/workbench/contrib/scm/browser/scmViewService';
import { SCMRepositoriesViewPane } from 'vs/workbench/contrib/scm/browser/scmRepositoriesViewPane';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { Context as SuggestContext } from 'vs/editor/contrib/suggest/browser/suggest';
import { MANAGE_TRUST_COMMAND_ID, WorkspaceTrustContext } from 'vs/workbench/contrib/workspace/common/workspace';
import { IQuickDiffService } from 'vs/workbench/contrib/scm/common/quickDiff';
import { QuickDiffService } from 'vs/workbench/contrib/scm/common/quickDiffService';
import { SCMSyncViewPane } from 'vs/workbench/contrib/scm/browser/scmSyncViewPane';
import { getActiveElement } from 'vs/base/browser/dom';

ModesRegistry.registerLanguage({
	id: 'scminput',
	extensions: [],
	aliases: [], // hide from language selector
	mimetypes: ['text/x-scm-input']
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(DirtyDiffWorkbenchController, LifecyclePhase.Restored);

const sourceControlViewIcon = registerIcon('source-control-view-icon', Codicon.sourceControl, localize('sourceControlViewIcon', 'View icon of the Source Control view.'));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEWLET_ID,
	title: { value: localize('source control', "Source Control"), original: 'Source Control' },
	ctorDescriptor: new SyncDescriptor(SCMViewPaneContainer),
	storageId: 'workbench.scm.views.state',
	icon: sourceControlViewIcon,
	alwaysUseContainerInfo: true,
	order: 2,
	hideIfEmpty: true,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViewWelcomeContent(VIEW_PANE_ID, {
	content: localize('no open repo', "No source control providers registered."),
	when: 'default'
});

viewsRegistry.registerViewWelcomeContent(VIEW_PANE_ID, {
	content: localize('no open repo in an untrusted workspace', "None of the registered source control providers work in Restricted Mode."),
	when: ContextKeyExpr.and(ContextKeyExpr.equals('scm.providerCount', 0), WorkspaceTrustContext.IsEnabled, WorkspaceTrustContext.IsTrusted.toNegated())
});

viewsRegistry.registerViewWelcomeContent(VIEW_PANE_ID, {
	content: `[${localize('manageWorkspaceTrustAction', "Manage Workspace Trust")}](command:${MANAGE_TRUST_COMMAND_ID})`,
	when: ContextKeyExpr.and(ContextKeyExpr.equals('scm.providerCount', 0), WorkspaceTrustContext.IsEnabled, WorkspaceTrustContext.IsTrusted.toNegated())
});

viewsRegistry.registerViews([{
	id: VIEW_PANE_ID,
	name: localize2('source control', "Source Control"),
	ctorDescriptor: new SyncDescriptor(SCMViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	weight: 60,
	order: -999,
	containerIcon: sourceControlViewIcon,
	openCommandActionDescriptor: {
		id: viewContainer.id,
		mnemonicTitle: localize({ key: 'miViewSCM', comment: ['&& denotes a mnemonic'] }, "Source &&Control"),
		keybindings: {
			primary: 0,
			win: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG },
			linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG },
			mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyG },
		},
		order: 2,
	}
}], viewContainer);

viewsRegistry.registerViews([{
	id: REPOSITORIES_VIEW_PANE_ID,
	name: localize2('source control repositories', "Source Control Repositories"),
	ctorDescriptor: new SyncDescriptor(SCMRepositoriesViewPane),
	canToggleVisibility: true,
	hideByDefault: true,
	canMoveView: true,
	weight: 20,
	order: -1000,
	when: ContextKeyExpr.and(ContextKeyExpr.has('scm.providerCount'), ContextKeyExpr.notEquals('scm.providerCount', 0)),
	// readonly when = ContextKeyExpr.or(ContextKeyExpr.equals('config.scm.alwaysShowProviders', true), ContextKeyExpr.and(ContextKeyExpr.notEquals('scm.providerCount', 0), ContextKeyExpr.notEquals('scm.providerCount', 1)));
	containerIcon: sourceControlViewIcon
}], viewContainer);

viewsRegistry.registerViews([{
	id: SYNC_VIEW_PANE_ID,
	name: localize2('source control sync', "Source Control Sync"),
	ctorDescriptor: new SyncDescriptor(SCMSyncViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	weight: 20,
	order: -998,
	when: ContextKeyExpr.equals('config.scm.experimental.showSyncView', true),
}], viewContainer);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SCMActiveResourceContextKeyController, LifecyclePhase.Restored);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SCMStatusController, LifecyclePhase.Restored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'scm',
	order: 5,
	title: localize('scmConfigurationTitle', "Source Control"),
	type: 'object',
	scope: ConfigurationScope.RESOURCE,
	properties: {
		'scm.diffDecorations': {
			type: 'string',
			enum: ['all', 'gutter', 'overview', 'minimap', 'none'],
			enumDescriptions: [
				localize('scm.diffDecorations.all', "Show the diff decorations in all available locations."),
				localize('scm.diffDecorations.gutter', "Show the diff decorations only in the editor gutter."),
				localize('scm.diffDecorations.overviewRuler', "Show the diff decorations only in the overview ruler."),
				localize('scm.diffDecorations.minimap', "Show the diff decorations only in the minimap."),
				localize('scm.diffDecorations.none', "Do not show the diff decorations.")
			],
			default: 'all',
			description: localize('diffDecorations', "Controls diff decorations in the editor.")
		},
		'scm.diffDecorationsGutterWidth': {
			type: 'number',
			enum: [1, 2, 3, 4, 5],
			default: 3,
			description: localize('diffGutterWidth', "Controls the width(px) of diff decorations in gutter (added & modified).")
		},
		'scm.diffDecorationsGutterVisibility': {
			type: 'string',
			enum: ['always', 'hover'],
			enumDescriptions: [
				localize('scm.diffDecorationsGutterVisibility.always', "Show the diff decorator in the gutter at all times."),
				localize('scm.diffDecorationsGutterVisibility.hover', "Show the diff decorator in the gutter only on hover.")
			],
			description: localize('scm.diffDecorationsGutterVisibility', "Controls the visibility of the Source Control diff decorator in the gutter."),
			default: 'always'
		},
		'scm.diffDecorationsGutterAction': {
			type: 'string',
			enum: ['diff', 'none'],
			enumDescriptions: [
				localize('scm.diffDecorationsGutterAction.diff', "Show the inline diff Peek view on click."),
				localize('scm.diffDecorationsGutterAction.none', "Do nothing.")
			],
			description: localize('scm.diffDecorationsGutterAction', "Controls the behavior of Source Control diff gutter decorations."),
			default: 'diff'
		},
		'scm.diffDecorationsGutterPattern': {
			type: 'object',
			description: localize('diffGutterPattern', "Controls whether a pattern is used for the diff decorations in gutter."),
			additionalProperties: false,
			properties: {
				'added': {
					type: 'boolean',
					description: localize('diffGutterPatternAdded', "Use pattern for the diff decorations in gutter for added lines."),
				},
				'modified': {
					type: 'boolean',
					description: localize('diffGutterPatternModifed', "Use pattern for the diff decorations in gutter for modified lines."),
				},
			},
			default: {
				'added': false,
				'modified': true
			}
		},
		'scm.diffDecorationsIgnoreTrimWhitespace': {
			type: 'string',
			enum: ['true', 'false', 'inherit'],
			enumDescriptions: [
				localize('scm.diffDecorationsIgnoreTrimWhitespace.true', "Ignore leading and trailing whitespace."),
				localize('scm.diffDecorationsIgnoreTrimWhitespace.false', "Do not ignore leading and trailing whitespace."),
				localize('scm.diffDecorationsIgnoreTrimWhitespace.inherit', "Inherit from `diffEditor.ignoreTrimWhitespace`.")
			],
			description: localize('diffDecorationsIgnoreTrimWhitespace', "Controls whether leading and trailing whitespace is ignored in Source Control diff gutter decorations."),
			default: 'false'
		},
		'scm.alwaysShowActions': {
			type: 'boolean',
			description: localize('alwaysShowActions', "Controls whether inline actions are always visible in the Source Control view."),
			default: false
		},
		'scm.countBadge': {
			type: 'string',
			enum: ['all', 'focused', 'off'],
			enumDescriptions: [
				localize('scm.countBadge.all', "Show the sum of all Source Control Provider count badges."),
				localize('scm.countBadge.focused', "Show the count badge of the focused Source Control Provider."),
				localize('scm.countBadge.off', "Disable the Source Control count badge.")
			],
			description: localize('scm.countBadge', "Controls the count badge on the Source Control icon on the Activity Bar."),
			default: 'all'
		},
		'scm.providerCountBadge': {
			type: 'string',
			enum: ['hidden', 'auto', 'visible'],
			enumDescriptions: [
				localize('scm.providerCountBadge.hidden', "Hide Source Control Provider count badges."),
				localize('scm.providerCountBadge.auto', "Only show count badge for Source Control Provider when non-zero."),
				localize('scm.providerCountBadge.visible', "Show Source Control Provider count badges.")
			],
			description: localize('scm.providerCountBadge', "Controls the count badges on Source Control Provider headers. These headers only appear when there is more than one provider."),
			default: 'hidden'
		},
		'scm.defaultViewMode': {
			type: 'string',
			enum: ['tree', 'list'],
			enumDescriptions: [
				localize('scm.defaultViewMode.tree', "Show the repository changes as a tree."),
				localize('scm.defaultViewMode.list', "Show the repository changes as a list.")
			],
			description: localize('scm.defaultViewMode', "Controls the default Source Control repository view mode."),
			default: 'list'
		},
		'scm.defaultViewSortKey': {
			type: 'string',
			enum: ['name', 'path', 'status'],
			enumDescriptions: [
				localize('scm.defaultViewSortKey.name', "Sort the repository changes by file name."),
				localize('scm.defaultViewSortKey.path', "Sort the repository changes by path."),
				localize('scm.defaultViewSortKey.status', "Sort the repository changes by Source Control status.")
			],
			description: localize('scm.defaultViewSortKey', "Controls the default Source Control repository changes sort order when viewed as a list."),
			default: 'path'
		},
		'scm.autoReveal': {
			type: 'boolean',
			description: localize('autoReveal', "Controls whether the Source Control view should automatically reveal and select files when opening them."),
			default: true
		},
		'scm.inputFontFamily': {
			type: 'string',
			markdownDescription: localize('inputFontFamily', "Controls the font for the input message. Use `default` for the workbench user interface font family, `editor` for the `#editor.fontFamily#`'s value, or a custom font family."),
			default: 'default'
		},
		'scm.inputFontSize': {
			type: 'number',
			markdownDescription: localize('inputFontSize', "Controls the font size for the input message in pixels."),
			default: 13
		},
		'scm.alwaysShowRepositories': {
			type: 'boolean',
			markdownDescription: localize('alwaysShowRepository', "Controls whether repositories should always be visible in the Source Control view."),
			default: false
		},
		'scm.repositories.sortOrder': {
			type: 'string',
			enum: ['discovery time', 'name', 'path'],
			enumDescriptions: [
				localize('scm.repositoriesSortOrder.discoveryTime', "Repositories in the Source Control Repositories view are sorted by discovery time. Repositories in the Source Control view are sorted in the order that they were selected."),
				localize('scm.repositoriesSortOrder.name', "Repositories in the Source Control Repositories and Source Control views are sorted by repository name."),
				localize('scm.repositoriesSortOrder.path', "Repositories in the Source Control Repositories and Source Control views are sorted by repository path.")
			],
			description: localize('repositoriesSortOrder', "Controls the sort order of the repositories in the source control repositories view."),
			default: 'discovery time'
		},
		'scm.repositories.visible': {
			type: 'number',
			description: localize('providersVisible', "Controls how many repositories are visible in the Source Control Repositories section. Set to 0, to be able to manually resize the view."),
			default: 10
		},
		'scm.showActionButton': {
			type: 'boolean',
			markdownDescription: localize('showActionButton', "Controls whether an action button can be shown in the Source Control view."),
			default: true
		},
		'scm.experimental.showSyncView': {
			type: 'boolean',
			description: localize('showSyncView', "Controls whether the Source Control Sync view is shown."),
			default: false
		}
	}
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'scm.acceptInput',
	metadata: { description: localize('scm accept', "Source Control: Accept Input"), args: [] },
	weight: KeybindingWeight.WorkbenchContrib,
	when: ContextKeyExpr.has('scmRepository'),
	primary: KeyMod.CtrlCmd | KeyCode.Enter,
	handler: accessor => {
		const contextKeyService = accessor.get(IContextKeyService);
		const context = contextKeyService.getContext(getActiveElement());
		const repositoryId = context.getValue<string | undefined>('scmRepository');

		if (!repositoryId) {
			return Promise.resolve(null);
		}

		const scmService = accessor.get(ISCMService);
		const repository = scmService.getRepository(repositoryId);

		if (!repository?.provider.acceptInputCommand) {
			return Promise.resolve(null);
		}

		const id = repository.provider.acceptInputCommand.id;
		const args = repository.provider.acceptInputCommand.arguments;
		const commandService = accessor.get(ICommandService);

		return commandService.executeCommand(id, ...(args || []));
	}
});

const viewNextCommitCommand = {
	description: { description: localize('scm view next commit', "Source Control: View Next Commit"), args: [] },
	weight: KeybindingWeight.WorkbenchContrib,
	handler: (accessor: ServicesAccessor) => {
		const contextKeyService = accessor.get(IContextKeyService);
		const scmService = accessor.get(ISCMService);
		const context = contextKeyService.getContext(getActiveElement());
		const repositoryId = context.getValue<string | undefined>('scmRepository');
		const repository = repositoryId ? scmService.getRepository(repositoryId) : undefined;
		repository?.input.showNextHistoryValue();
	}
};

const viewPreviousCommitCommand = {
	description: { description: localize('scm view previous commit', "Source Control: View Previous Commit"), args: [] },
	weight: KeybindingWeight.WorkbenchContrib,
	handler: (accessor: ServicesAccessor) => {
		const contextKeyService = accessor.get(IContextKeyService);
		const scmService = accessor.get(ISCMService);
		const context = contextKeyService.getContext(getActiveElement());
		const repositoryId = context.getValue<string | undefined>('scmRepository');
		const repository = repositoryId ? scmService.getRepository(repositoryId) : undefined;
		repository?.input.showPreviousHistoryValue();
	}
};

KeybindingsRegistry.registerCommandAndKeybindingRule({
	...viewNextCommitCommand,
	id: 'scm.viewNextCommit',
	when: ContextKeyExpr.and(ContextKeyExpr.has('scmRepository'), ContextKeyExpr.has('scmInputIsInLastPosition'), SuggestContext.Visible.toNegated()),
	primary: KeyCode.DownArrow
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	...viewPreviousCommitCommand,
	id: 'scm.viewPreviousCommit',
	when: ContextKeyExpr.and(ContextKeyExpr.has('scmRepository'), ContextKeyExpr.has('scmInputIsInFirstPosition'), SuggestContext.Visible.toNegated()),
	primary: KeyCode.UpArrow
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	...viewNextCommitCommand,
	id: 'scm.forceViewNextCommit',
	when: ContextKeyExpr.has('scmRepository'),
	primary: KeyMod.Alt | KeyCode.DownArrow
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	...viewPreviousCommitCommand,
	id: 'scm.forceViewPreviousCommit',
	when: ContextKeyExpr.has('scmRepository'),
	primary: KeyMod.Alt | KeyCode.UpArrow
});

CommandsRegistry.registerCommand('scm.openInIntegratedTerminal', async (accessor, provider: ISCMProvider) => {
	if (!provider || !provider.rootUri) {
		return;
	}

	const commandService = accessor.get(ICommandService);
	await commandService.executeCommand('openInIntegratedTerminal', provider.rootUri);
});

CommandsRegistry.registerCommand('scm.openInTerminal', async (accessor, provider: ISCMProvider) => {
	if (!provider || !provider.rootUri) {
		return;
	}

	const commandService = accessor.get(ICommandService);
	await commandService.executeCommand('openInTerminal', provider.rootUri);
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControl, {
	group: '100_end',
	command: {
		id: 'scm.openInTerminal',
		title: localize('open in external terminal', "Open in External Terminal")
	},
	when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProviderHasRootUri', true), ContextKeyExpr.or(ContextKeyExpr.equals('config.terminal.sourceControlRepositoriesKind', 'external'), ContextKeyExpr.equals('config.terminal.sourceControlRepositoriesKind', 'both')))
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControl, {
	group: '100_end',
	command: {
		id: 'scm.openInIntegratedTerminal',
		title: localize('open in integrated terminal', "Open in Integrated Terminal")
	},
	when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProviderHasRootUri', true), ContextKeyExpr.or(ContextKeyExpr.equals('config.terminal.sourceControlRepositoriesKind', 'integrated'), ContextKeyExpr.equals('config.terminal.sourceControlRepositoriesKind', 'both')))
});

registerSingleton(ISCMService, SCMService, InstantiationType.Delayed);
registerSingleton(ISCMViewService, SCMViewService, InstantiationType.Delayed);
registerSingleton(IQuickDiffService, QuickDiffService, InstantiationType.Delayed);
