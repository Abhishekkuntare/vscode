/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { Event } from 'vs/base/common/event';
import { IMarkdownString } from 'vs/base/common/htmlContent';
import { IDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { Range, IRange } from 'vs/editor/common/core/range';
import { ProviderResult, Location } from 'vs/editor/common/languages';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IChatModel, ChatModel, ISerializableChatData } from 'vs/workbench/contrib/chat/common/chatModel';
import { IParsedChatRequest } from 'vs/workbench/contrib/chat/common/chatParserTypes';
import { IChatRequestVariableValue } from 'vs/workbench/contrib/chat/common/chatVariables';

export interface IChat {
	id: number; // TODO Maybe remove this and move to a subclass that only the provider knows about
	requesterUsername: string;
	requesterAvatarIconUri?: URI;
	responderUsername: string;
	responderAvatarIconUri?: URI;
	inputPlaceholder?: string;
	onDidChangeState?: Event<any>;
	dispose?(): void;
}

export interface IChatRequest {
	session: IChat;
	message: string;
	variables: Record<string, IChatRequestVariableValue[]>;
}

export interface IChatResponseErrorDetails {
	message: string;
	responseIsIncomplete?: boolean;
	responseIsFiltered?: boolean;
}

export interface IChatResponse {
	session: IChat;
	errorDetails?: IChatResponseErrorDetails;
	timings?: {
		firstProgress: number;
		totalElapsed: number;
	};
}

export interface IChatResponseProgressFileTreeData {
	label: string;
	uri: URI;
	children?: IChatResponseProgressFileTreeData[];
}

export type IDocumentContext = {
	uri: URI;
	version: number;
	ranges: IRange[];
};

export function isIDocumentContext(obj: unknown): obj is IDocumentContext {
	return (
		!!obj &&
		typeof obj === 'object' &&
		'uri' in obj && obj.uri instanceof URI &&
		'version' in obj && typeof obj.version === 'number' &&
		'ranges' in obj && Array.isArray(obj.ranges) && obj.ranges.every(Range.isIRange)
	);
}

export type IUsedContext = {
	documents: IDocumentContext[];
};

export function isIUsedContext(obj: unknown): obj is IUsedContext {
	return (
		!!obj &&
		typeof obj === 'object' &&
		'documents' in obj &&
		Array.isArray(obj.documents) &&
		obj.documents.every(isIDocumentContext)
	);
}

export interface IChatContentReference {
	reference: URI | Location;
}

export interface IChatContentInlineReference {
	inlineReference: URI | Location;
	name?: string;
}

export type IChatProgress =
	| { content: string | IMarkdownString }
	| { requestId: string }
	| { treeData: IChatResponseProgressFileTreeData }
	| { placeholder: string; resolvedContent: Promise<string | IMarkdownString | { treeData: IChatResponseProgressFileTreeData }> }
	| IUsedContext
	| IChatContentReference
	| IChatContentInlineReference;

export interface IPersistedChatState { }
export interface IChatProvider {
	readonly id: string;
	readonly displayName: string;
	readonly iconUrl?: string;
	prepareSession(initialState: IPersistedChatState | undefined, token: CancellationToken): ProviderResult<IChat | undefined>;
	provideWelcomeMessage?(token: CancellationToken): ProviderResult<(string | IChatReplyFollowup[])[] | undefined>;
	provideSampleQuestions?(token: CancellationToken): ProviderResult<IChatReplyFollowup[] | undefined>;
	provideFollowups?(session: IChat, token: CancellationToken): ProviderResult<IChatFollowup[] | undefined>;
	provideReply(request: IChatRequest, progress: (progress: IChatProgress) => void, token: CancellationToken): ProviderResult<IChatResponse>;
	provideSlashCommands?(session: IChat, token: CancellationToken): ProviderResult<ISlashCommand[]>;
	removeRequest?(session: IChat, requestId: string): void;
}

export interface ISlashCommand {
	command: string;
	sortText?: string;
	detail?: string;

	/**
	 * Whether the command should execute as soon
	 * as it is entered. Defaults to `false`.
	 */
	executeImmediately?: boolean;
	/**
	 * Whether executing the command puts the
	 * chat into a persistent mode, where the
	 * slash command is prepended to the chat input.
	 */
	shouldRepopulate?: boolean;
	/**
	 * Placeholder text to render in the chat input
	 * when the slash command has been repopulated.
	 * Has no effect if `shouldRepopulate` is `false`.
	 */
	followupPlaceholder?: string;
	/**
	 * The slash command(s) that this command wants to be
	 * deprioritized in favor of.
	 */
	yieldsTo?: ReadonlyArray<{ readonly command: string }>;
}

export interface IChatReplyFollowup {
	kind: 'reply';
	message: string;
	title?: string;
	tooltip?: string;
	metadata?: any;
}

export interface IChatResponseCommandFollowup {
	kind: 'command';
	commandId: string;
	args?: any[];
	title: string; // supports codicon strings
	when?: string;
}

export type IChatFollowup = IChatReplyFollowup | IChatResponseCommandFollowup;

// Name has to match the one in vscode.d.ts for some reason
export enum InteractiveSessionVoteDirection {
	Down = 0,
	Up = 1
}

export interface IChatVoteAction {
	kind: 'vote';
	responseId: string;
	direction: InteractiveSessionVoteDirection;
}

export enum InteractiveSessionCopyKind {
	// Keyboard shortcut or context menu
	Action = 1,
	Toolbar = 2
}

export interface IChatCopyAction {
	kind: 'copy';
	responseId: string;
	codeBlockIndex: number;
	copyType: InteractiveSessionCopyKind;
	copiedCharacters: number;
	totalCharacters: number;
	copiedText: string;
}

export interface IChatInsertAction {
	kind: 'insert';
	responseId: string;
	codeBlockIndex: number;
	totalCharacters: number;
	newFile?: boolean;
}

export interface IChatTerminalAction {
	kind: 'runInTerminal';
	responseId: string;
	codeBlockIndex: number;
	languageId?: string;
}

export interface IChatCommandAction {
	kind: 'command';
	command: IChatResponseCommandFollowup;
}

export interface IChatFollowupAction {
	kind: 'followUp';
	followup: IChatReplyFollowup;
}

export type ChatUserAction = IChatVoteAction | IChatCopyAction | IChatInsertAction | IChatTerminalAction | IChatCommandAction | IChatFollowupAction;

export interface IChatUserActionEvent {
	action: ChatUserAction;
	providerId: string;
	agentId: string | undefined;
	sessionId: string;
	requestId: string;
}

export interface IChatDynamicRequest {
	/**
	 * The message that will be displayed in the UI
	 */
	message: string;

	/**
	 * Any extra metadata/context that will go to the provider.
	 */
	metadata?: any;
}

export interface IChatCompleteResponse {
	message: string | ReadonlyArray<IMarkdownString | IChatResponseProgressFileTreeData | IChatContentInlineReference>;
	errorDetails?: IChatResponseErrorDetails;
	followups?: IChatFollowup[];
}

export interface IChatDetail {
	sessionId: string;
	title: string;
}

export interface IChatProviderInfo {
	id: string;
	displayName: string;
}

export interface IChatTransferredSessionData {
	sessionId: string;
	inputValue: string;
}

export const IChatService = createDecorator<IChatService>('IChatService');

export interface IChatService {
	_serviceBrand: undefined;
	transferredSessionData: IChatTransferredSessionData | undefined;

	onDidSubmitSlashCommand: Event<{ slashCommand: string; sessionId: string }>;
	registerProvider(provider: IChatProvider): IDisposable;
	hasProviders(): boolean;
	getProviderInfos(): IChatProviderInfo[];
	startSession(providerId: string, token: CancellationToken): ChatModel | undefined;
	getSession(sessionId: string): IChatModel | undefined;
	getSessionId(sessionProviderId: number): string | undefined;
	getOrRestoreSession(sessionId: string): IChatModel | undefined;
	loadSessionFromContent(data: ISerializableChatData): IChatModel | undefined;

	/**
	 * Returns whether the request was accepted.
	 */
	sendRequest(sessionId: string, message: string, usedSlashCommand?: ISlashCommand): Promise<{ responseCompletePromise: Promise<void> } | undefined>;
	removeRequest(sessionid: string, requestId: string): Promise<void>;
	cancelCurrentRequestForSession(sessionId: string): void;
	getSlashCommands(sessionId: string, token: CancellationToken): Promise<ISlashCommand[]>;
	clearSession(sessionId: string): void;
	addCompleteRequest(sessionId: string, message: IParsedChatRequest | string, response: IChatCompleteResponse): void;
	sendRequestToProvider(sessionId: string, message: IChatDynamicRequest): void;
	getHistory(): IChatDetail[];
	removeHistoryEntry(sessionId: string): void;

	onDidPerformUserAction: Event<IChatUserActionEvent>;
	notifyUserAction(event: IChatUserActionEvent): void;
	onDidDisposeSession: Event<{ sessionId: string }>;

	transferChatSession(transferredSessionData: IChatTransferredSessionData, toWorkspace: URI): void;
}
