/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancelablePromise, createCancelablePromise } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { MarkdownString, isMarkdownString } from 'vs/base/common/htmlContent';
import { Iterable } from 'vs/base/common/iterator';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { revive } from 'vs/base/common/marshalling';
import { StopWatch } from 'vs/base/common/stopwatch';
import { URI, UriComponents } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { Progress } from 'vs/platform/progress/common/progress';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IChatAgentRequest, IChatAgentService } from 'vs/workbench/contrib/chat/common/chatAgents';
import { CONTEXT_PROVIDER_EXISTS } from 'vs/workbench/contrib/chat/common/chatContextKeys';
import { ChatModel, ChatModelInitState, ChatRequestModel, ChatWelcomeMessageModel, IChatModel, ISerializableChatData, ISerializableChatsData, isCompleteInteractiveProgressTreeData } from 'vs/workbench/contrib/chat/common/chatModel';
import { ChatRequestAgentPart, ChatRequestAgentSubcommandPart, ChatRequestSlashCommandPart } from 'vs/workbench/contrib/chat/common/chatParserTypes';
import { ChatMessageRole, IChatMessage } from 'vs/workbench/contrib/chat/common/chatProvider';
import { ChatRequestParser } from 'vs/workbench/contrib/chat/common/chatRequestParser';
import { IChat, IChatCompleteResponse, IChatDetail, IChatDynamicRequest, IChatFollowup, IChatProgress, IChatProvider, IChatProviderInfo, IChatReplyFollowup, IChatRequest, IChatResponse, IChatService, IChatTransferredSessionData, IChatUserActionEvent, ISlashCommand, InteractiveSessionCopyKind, InteractiveSessionVoteDirection } from 'vs/workbench/contrib/chat/common/chatService';
import { IChatSlashCommandService, IChatSlashFragment } from 'vs/workbench/contrib/chat/common/chatSlashCommands';
import { IChatVariablesService } from 'vs/workbench/contrib/chat/common/chatVariables';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';

const serializedChatKey = 'interactive.sessions';

const globalChatKey = 'chat.workspaceTransfer';
interface IChatTransfer {
	toWorkspace: UriComponents;
	timestampInMilliseconds: number;
	chat: ISerializableChatData;
	inputValue: string;
}
const SESSION_TRANSFER_EXPIRATION_IN_MILLISECONDS = 1000 * 60;

type ChatProviderInvokedEvent = {
	providerId: string;
	timeToFirstProgress: number;
	totalTime: number;
	result: 'success' | 'error' | 'errorWithOutput' | 'cancelled' | 'filtered';
	requestType: 'string' | 'followup' | 'slashCommand';
	slashCommand: string | undefined;
};

type ChatProviderInvokedClassification = {
	providerId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of the provider that was invoked.' };
	timeToFirstProgress: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The time in milliseconds from invoking the provider to getting the first data.' };
	totalTime: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The total time it took to run the provider\'s `provideResponseWithProgress`.' };
	result: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether invoking the ChatProvider resulted in an error.' };
	requestType: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The type of request that the user made.' };
	slashCommand?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The type of slashCommand used.' };
	owner: 'roblourens';
	comment: 'Provides insight into the performance of Chat providers.';
};

type ChatVoteEvent = {
	providerId: string;
	direction: 'up' | 'down';
};

type ChatVoteClassification = {
	providerId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of the provider that this response came from.' };
	direction: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the user voted up or down.' };
	owner: 'roblourens';
	comment: 'Provides insight into the performance of Chat providers.';
};

type ChatCopyEvent = {
	providerId: string;
	copyKind: 'action' | 'toolbar';
};

type ChatCopyClassification = {
	providerId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of the provider that this codeblock response came from.' };
	copyKind: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'How the copy was initiated.' };
	owner: 'roblourens';
	comment: 'Provides insight into the usage of Chat features.';
};

type ChatInsertEvent = {
	providerId: string;
	newFile: boolean;
};

type ChatInsertClassification = {
	providerId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of the provider that this codeblock response came from.' };
	newFile: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the code was inserted into a new untitled file.' };
	owner: 'roblourens';
	comment: 'Provides insight into the usage of Chat features.';
};

type ChatCommandEvent = {
	providerId: string;
	commandId: string;
};

type ChatCommandClassification = {
	providerId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of the provider that this codeblock response came from.' };
	commandId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The id of the command that was executed.' };
	owner: 'roblourens';
	comment: 'Provides insight into the usage of Chat features.';
};

type ChatTerminalEvent = {
	providerId: string;
	languageId: string;
};

type ChatTerminalClassification = {
	providerId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of the provider that this codeblock response came from.' };
	languageId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The language of the code that was run in the terminal.' };
	owner: 'roblourens';
	comment: 'Provides insight into the usage of Chat features.';
};

const maxPersistedSessions = 25;

export class ChatService extends Disposable implements IChatService {
	declare _serviceBrand: undefined;

	private readonly _providers = new Map<string, IChatProvider>();

	private readonly _sessionModels = new Map<string, ChatModel>();
	private readonly _pendingRequests = new Map<string, CancelablePromise<void>>();
	private readonly _persistedSessions: ISerializableChatsData;
	private readonly _hasProvider: IContextKey<boolean>;

	private _transferredSessionData: IChatTransferredSessionData | undefined;
	public get transferredSessionData(): IChatTransferredSessionData | undefined {
		return this._transferredSessionData;
	}

	private readonly _onDidPerformUserAction = this._register(new Emitter<IChatUserActionEvent>());
	public readonly onDidPerformUserAction: Event<IChatUserActionEvent> = this._onDidPerformUserAction.event;

	private readonly _onDidSubmitSlashCommand = this._register(new Emitter<{ slashCommand: string; sessionId: string }>());
	public readonly onDidSubmitSlashCommand = this._onDidSubmitSlashCommand.event;

	private readonly _onDidDisposeSession = this._register(new Emitter<{ sessionId: string }>());
	public readonly onDidDisposeSession = this._onDidDisposeSession.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IChatSlashCommandService private readonly chatSlashCommandService: IChatSlashCommandService,
		@IChatVariablesService private readonly chatVariablesService: IChatVariablesService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService
	) {
		super();

		this._hasProvider = CONTEXT_PROVIDER_EXISTS.bindTo(this.contextKeyService);

		const sessionData = storageService.get(serializedChatKey, StorageScope.WORKSPACE, '');
		if (sessionData) {
			this._persistedSessions = this.deserializeChats(sessionData);
			const countsForLog = Object.keys(this._persistedSessions).length;
			if (countsForLog > 0) {
				this.trace('constructor', `Restored ${countsForLog} persisted sessions`);
			}
		} else {
			this._persistedSessions = {};
		}

		const transferredData = this.getTransferredSessionData();
		const transferredChat = transferredData?.chat;
		if (transferredChat) {
			this.trace('constructor', `Transferred session ${transferredChat.sessionId}`);
			this._persistedSessions[transferredChat.sessionId] = transferredChat;
			this._transferredSessionData = { sessionId: transferredChat.sessionId, inputValue: transferredData.inputValue };
		}

		this._register(storageService.onWillSaveState(() => this.saveState()));
	}

	private saveState(): void {
		let allSessions: (ChatModel | ISerializableChatData)[] = Array.from(this._sessionModels.values())
			.filter(session => session.getRequests().length > 0);
		allSessions = allSessions.concat(
			Object.values(this._persistedSessions)
				.filter(session => !this._sessionModels.has(session.sessionId))
				.filter(session => session.requests.length));
		allSessions.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0));
		allSessions = allSessions.slice(0, maxPersistedSessions);
		if (allSessions.length) {
			this.trace('onWillSaveState', `Persisting ${allSessions.length} sessions`);
		}

		const serialized = JSON.stringify(allSessions);

		if (allSessions.length) {
			this.trace('onWillSaveState', `Persisting ${serialized.length} chars`);
		}

		this.storageService.store(serializedChatKey, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	notifyUserAction(action: IChatUserActionEvent): void {
		if (action.action.kind === 'vote') {
			this.telemetryService.publicLog2<ChatVoteEvent, ChatVoteClassification>('interactiveSessionVote', {
				providerId: action.providerId,
				direction: action.action.direction === InteractiveSessionVoteDirection.Up ? 'up' : 'down'
			});
		} else if (action.action.kind === 'copy') {
			this.telemetryService.publicLog2<ChatCopyEvent, ChatCopyClassification>('interactiveSessionCopy', {
				providerId: action.providerId,
				copyKind: action.action.copyType === InteractiveSessionCopyKind.Action ? 'action' : 'toolbar'
			});
		} else if (action.action.kind === 'insert') {
			this.telemetryService.publicLog2<ChatInsertEvent, ChatInsertClassification>('interactiveSessionInsert', {
				providerId: action.providerId,
				newFile: !!action.action.newFile
			});
		} else if (action.action.kind === 'command') {
			const command = CommandsRegistry.getCommand(action.action.command.commandId);
			const commandId = command ? action.action.command.commandId : 'INVALID';
			this.telemetryService.publicLog2<ChatCommandEvent, ChatCommandClassification>('interactiveSessionCommand', {
				providerId: action.providerId,
				commandId
			});
		} else if (action.action.kind === 'runInTerminal') {
			this.telemetryService.publicLog2<ChatTerminalEvent, ChatTerminalClassification>('interactiveSessionRunInTerminal', {
				providerId: action.providerId,
				languageId: action.action.languageId ?? ''
			});
		}

		this._onDidPerformUserAction.fire(action);
	}

	private trace(method: string, message: string): void {
		this.logService.trace(`ChatService#${method}: ${message}`);
	}

	private error(method: string, message: string): void {
		this.logService.error(`ChatService#${method} ${message}`);
	}

	private deserializeChats(sessionData: string): ISerializableChatsData {
		try {
			const arrayOfSessions: ISerializableChatData[] = revive(JSON.parse(sessionData)); // Revive serialized URIs in session data
			if (!Array.isArray(arrayOfSessions)) {
				throw new Error('Expected array');
			}

			const sessions = arrayOfSessions.reduce((acc, session) => {
				// Revive serialized markdown strings in response data
				for (const request of session.requests) {
					if (Array.isArray(request.response)) {
						request.response = request.response.map((response) => {
							if (typeof response === 'string') {
								return new MarkdownString(response);
							}
							return response;
						});
					} else if (typeof request.response === 'string') {
						request.response = [new MarkdownString(request.response)];
					}
				}

				acc[session.sessionId] = session;
				return acc;
			}, {} as ISerializableChatsData);
			return sessions;
		} catch (err) {
			this.error('deserializeChats', `Malformed session data: ${err}. [${sessionData.substring(0, 20)}${sessionData.length > 20 ? '...' : ''}]`);
			return {};
		}
	}

	private getTransferredSessionData(): IChatTransfer | undefined {
		const data: IChatTransfer[] = this.storageService.getObject(globalChatKey, StorageScope.PROFILE, []);
		const workspaceUri = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!workspaceUri) {
			return;
		}

		const thisWorkspace = workspaceUri.toString();
		const currentTime = Date.now();
		// Only use transferred data if it was created recently
		const transferred = data.find(item => URI.revive(item.toWorkspace).toString() === thisWorkspace && (currentTime - item.timestampInMilliseconds < SESSION_TRANSFER_EXPIRATION_IN_MILLISECONDS));
		// Keep data that isn't for the current workspace and that hasn't expired yet
		const filtered = data.filter(item => URI.revive(item.toWorkspace).toString() !== thisWorkspace && (currentTime - item.timestampInMilliseconds < SESSION_TRANSFER_EXPIRATION_IN_MILLISECONDS));
		this.storageService.store(globalChatKey, JSON.stringify(filtered), StorageScope.PROFILE, StorageTarget.MACHINE);
		return transferred;
	}

	getHistory(): IChatDetail[] {
		const sessions = Object.values(this._persistedSessions)
			.filter(session => session.requests.length > 0);
		sessions.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0));

		return sessions
			.filter(session => !this._sessionModels.has(session.sessionId))
			.filter(session => !session.isImported)
			.map(item => {
				const firstRequestMessage = item.requests[0]?.message;
				return {
					sessionId: item.sessionId,
					title: (typeof firstRequestMessage === 'string' ? firstRequestMessage :
						firstRequestMessage?.text) ?? '',
				};
			});
	}

	removeHistoryEntry(sessionId: string): void {
		delete this._persistedSessions[sessionId];
	}

	startSession(providerId: string, token: CancellationToken): ChatModel {
		this.trace('startSession', `providerId=${providerId}`);
		return this._startSession(providerId, undefined, token);
	}

	private _startSession(providerId: string, someSessionHistory: ISerializableChatData | undefined, token: CancellationToken): ChatModel {
		this.trace('_startSession', `providerId=${providerId}`);
		const model = this.instantiationService.createInstance(ChatModel, providerId, someSessionHistory);
		this._sessionModels.set(model.sessionId, model);
		this.initializeSession(model, token);
		return model;
	}

	private reinitializeModel(model: ChatModel): void {
		this.trace('reinitializeModel', `Start reinit`);
		this.initializeSession(model, CancellationToken.None);
	}

	private async initializeSession(model: ChatModel, token: CancellationToken): Promise<void> {
		try {
			this.trace('initializeSession', `Initialize session ${model.sessionId}`);
			model.startInitialize();
			await this.extensionService.activateByEvent(`onInteractiveSession:${model.providerId}`);

			const provider = this._providers.get(model.providerId);
			if (!provider) {
				throw new Error(`Unknown provider: ${model.providerId}`);
			}

			let session: IChat | undefined;
			try {
				session = await provider.prepareSession(model.providerState, token) ?? undefined;
			} catch (err) {
				this.trace('initializeSession', `Provider initializeSession threw: ${err}`);
			}

			if (!session) {
				throw new Error('Provider returned no session');
			}

			this.trace('startSession', `Provider returned session`);

			const welcomeMessage = model.welcomeMessage ? undefined : await provider.provideWelcomeMessage?.(token) ?? undefined;
			const welcomeModel = welcomeMessage && new ChatWelcomeMessageModel(
				model,
				welcomeMessage.map(item => typeof item === 'string' ? new MarkdownString(item) : item as IChatReplyFollowup[]),
				await provider.provideSampleQuestions?.(token) ?? []
			);

			model.initialize(session, welcomeModel);
		} catch (err) {
			this.trace('startSession', `initializeSession failed: ${err}`);
			model.setInitializationError(err);
			model.dispose();
			this._sessionModels.delete(model.sessionId);
			this._onDidDisposeSession.fire({ sessionId: model.sessionId });
		}
	}

	getSession(sessionId: string): IChatModel | undefined {
		return this._sessionModels.get(sessionId);
	}

	getSessionId(sessionProviderId: number): string | undefined {
		return Iterable.find(this._sessionModels.values(), model => model.session?.id === sessionProviderId)?.sessionId;
	}

	getOrRestoreSession(sessionId: string): ChatModel | undefined {
		this.trace('getOrRestoreSession', `sessionId: ${sessionId}`);
		const model = this._sessionModels.get(sessionId);
		if (model) {
			return model;
		}

		const sessionData = this._persistedSessions[sessionId];
		if (!sessionData) {
			return undefined;
		}

		if (sessionId === this.transferredSessionData?.sessionId) {
			this._transferredSessionData = undefined;
		}

		return this._startSession(sessionData.providerId, sessionData, CancellationToken.None);
	}

	loadSessionFromContent(data: ISerializableChatData): IChatModel | undefined {
		return this._startSession(data.providerId, data, CancellationToken.None);
	}

	async sendRequest(sessionId: string, request: string, usedSlashCommand?: ISlashCommand): Promise<{ responseCompletePromise: Promise<void> } | undefined> {
		this.trace('sendRequest', `sessionId: ${sessionId}, message: ${request.substring(0, 20)}${request.length > 20 ? '[...]' : ''}}`);
		if (!request.trim()) {
			this.trace('sendRequest', 'Rejected empty message');
			return;
		}

		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await model.waitForInitialization();
		const provider = this._providers.get(model.providerId);
		if (!provider) {
			throw new Error(`Unknown provider: ${model.providerId}`);
		}

		if (this._pendingRequests.has(sessionId)) {
			this.trace('sendRequest', `Session ${sessionId} already has a pending request`);
			return;
		}

		// This method is only returning whether the request was accepted - don't block on the actual request
		return { responseCompletePromise: this._sendRequestAsync(model, sessionId, provider, request, usedSlashCommand) };
	}

	private async _sendRequestAsync(model: ChatModel, sessionId: string, provider: IChatProvider, message: string, usedSlashCommand?: ISlashCommand): Promise<void> {
		const parsedRequest = await this.instantiationService.createInstance(ChatRequestParser).parseChatRequest(sessionId, message);

		let request: ChatRequestModel;
		const agentPart = 'kind' in parsedRequest ? undefined : parsedRequest.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart);
		const agentSlashCommandPart = 'kind' in parsedRequest ? undefined : parsedRequest.parts.find((r): r is ChatRequestAgentSubcommandPart => r instanceof ChatRequestAgentSubcommandPart);
		const commandPart = 'kind' in parsedRequest ? undefined : parsedRequest.parts.find((r): r is ChatRequestSlashCommandPart => r instanceof ChatRequestSlashCommandPart);

		let gotProgress = false;
		const requestType = commandPart ? 'slashCommand' : 'string';

		const rawResponsePromise = createCancelablePromise<void>(async token => {
			const progressCallback = (progress: IChatProgress) => {
				if (token.isCancellationRequested) {
					return;
				}

				gotProgress = true;

				if ('content' in progress) {
					this.trace('sendRequest', `Provider returned progress for session ${model.sessionId}, ${typeof progress.content === 'string' ? progress.content.length : progress.content.value.length} chars`);
				} else if ('placeholder' in progress) {
					this.trace('sendRequest', `Provider returned placeholder for session ${model.sessionId}, ${progress.placeholder}`);
				} else if (isCompleteInteractiveProgressTreeData(progress)) {
					// This isn't exposed in API
					this.trace('sendRequest', `Provider returned tree data for session ${model.sessionId}, ${progress.treeData.label}`);
				} else if ('documents' in progress) {
					this.trace('sendRequest', `Provider returned documents for session ${model.sessionId}:\n ${JSON.stringify(progress.documents, null, '\t')}`);
				} else if ('reference' in progress) {
					this.trace('sendRequest', `Provider returned a reference for session ${model.sessionId}:\n ${JSON.stringify(progress.reference, null, '\t')}`);
				} else if ('inlineReference' in progress) {
					this.trace('sendRequest', `Provider returned an inline reference for session ${model.sessionId}:\n ${JSON.stringify(progress.inlineReference, null, '\t')}`);
				} else {
					this.trace('sendRequest', `Provider returned id for session ${model.sessionId}, ${progress.requestId}`);
				}

				model.acceptResponseProgress(request, progress);
			};

			const stopWatch = new StopWatch(false);
			const listener = token.onCancellationRequested(() => {
				this.trace('sendRequest', `Request for session ${model.sessionId} was cancelled`);
				this.telemetryService.publicLog2<ChatProviderInvokedEvent, ChatProviderInvokedClassification>('interactiveSessionProviderInvoked', {
					providerId: provider.id,
					timeToFirstProgress: -1,
					// Normally timings happen inside the EH around the actual provider. For cancellation we can measure how long the user waited before cancelling
					totalTime: stopWatch.elapsed(),
					result: 'cancelled',
					requestType,
					slashCommand: usedSlashCommand?.command
				});

				model.cancelRequest(request);
			});

			try {
				if (usedSlashCommand?.command) {
					this._onDidSubmitSlashCommand.fire({ slashCommand: usedSlashCommand.command, sessionId: model.sessionId });
				}

				let rawResponse: IChatResponse | null | undefined;
				let agentOrCommandFollowups: Promise<IChatFollowup[] | undefined> | undefined = undefined;

				const defaultAgent = this.chatAgentService.getDefaultAgent();
				if (agentPart || defaultAgent) {
					const agent = (agentPart?.agent ?? defaultAgent)!;
					const history: IChatMessage[] = [];
					for (const request of model.getRequests()) {
						if (!request.response) {
							continue;
						}

						history.push({ role: ChatMessageRole.User, content: request.message.text });
						history.push({ role: ChatMessageRole.Assistant, content: request.response.response.asString() });
					}

					request = model.addRequest(parsedRequest, agent);
					const requestProps: IChatAgentRequest = {
						sessionId,
						requestId: request.id,
						message,
						variables: {},
						command: agentSlashCommandPart?.command.name ?? '',
					};
					if ('parts' in parsedRequest) {
						const varResult = await this.chatVariablesService.resolveVariables(parsedRequest, model, token);
						requestProps.variables = varResult.variables;
						requestProps.message = varResult.prompt;
					}

					const agentResult = await this.chatAgentService.invokeAgent(agent.id, requestProps, progressCallback, history, token);
					rawResponse = {
						session: model.session!,
						errorDetails: agentResult.errorDetails,
						timings: agentResult.timings
					};
					agentOrCommandFollowups = agentResult?.followUp ? Promise.resolve(agentResult.followUp) :
						this.chatAgentService.getFollowups(agent.id, sessionId, CancellationToken.None);
				} else if (commandPart && this.chatSlashCommandService.hasCommand(commandPart.slashCommand.command)) {
					request = model.addRequest(parsedRequest);
					// contributed slash commands
					// TODO: spell this out in the UI
					const history: IChatMessage[] = [];
					for (const request of model.getRequests()) {
						if (!request.response) {
							continue;
						}
						history.push({ role: ChatMessageRole.User, content: request.message.text });
						history.push({ role: ChatMessageRole.Assistant, content: request.response.response.asString() });
					}
					const commandResult = await this.chatSlashCommandService.executeCommand(commandPart.slashCommand.command, message.substring(commandPart.slashCommand.command.length + 1).trimStart(), new Progress<IChatSlashFragment>(p => {
						const { content } = p;
						const data = isCompleteInteractiveProgressTreeData(content) ? content : { content };
						progressCallback(data);
					}), history, token);
					agentOrCommandFollowups = Promise.resolve(commandResult?.followUp);
					rawResponse = { session: model.session! };

				} else {
					request = model.addRequest(parsedRequest);
					const requestProps: IChatRequest = {
						session: model.session!,
						message,
						variables: {}
					};

					if ('parts' in parsedRequest) {
						const varResult = await this.chatVariablesService.resolveVariables(parsedRequest, model, token);
						requestProps.variables = varResult.variables;
						requestProps.message = varResult.prompt;
					}
					rawResponse = await provider.provideReply(requestProps, progressCallback, token);
				}

				if (token.isCancellationRequested) {
					return;
				} else {
					if (!rawResponse) {
						this.trace('sendRequest', `Provider returned no response for session ${model.sessionId}`);
						rawResponse = { session: model.session!, errorDetails: { message: localize('emptyResponse', "Provider returned null response") } };
					}

					const result = rawResponse.errorDetails?.responseIsFiltered ? 'filtered' :
						rawResponse.errorDetails && gotProgress ? 'errorWithOutput' :
							rawResponse.errorDetails ? 'error' :
								'success';
					this.telemetryService.publicLog2<ChatProviderInvokedEvent, ChatProviderInvokedClassification>('interactiveSessionProviderInvoked', {
						providerId: provider.id,
						timeToFirstProgress: rawResponse.timings?.firstProgress ?? 0,
						totalTime: rawResponse.timings?.totalElapsed ?? 0,
						result,
						requestType,
						slashCommand: usedSlashCommand?.command
					});
					model.setResponse(request, rawResponse);
					this.trace('sendRequest', `Provider returned response for session ${model.sessionId}`);

					// TODO refactor this or rethink the API https://github.com/microsoft/vscode-copilot/issues/593
					if (agentOrCommandFollowups) {
						agentOrCommandFollowups.then(followups => {
							model.setFollowups(request, followups);
							model.completeResponse(request);
						});
					} else if (provider.provideFollowups) {
						Promise.resolve(provider.provideFollowups(model.session!, CancellationToken.None)).then(providerFollowups => {
							model.setFollowups(request, providerFollowups ?? undefined);
							model.completeResponse(request);
						});
					} else {
						model.completeResponse(request);
					}
				}
			} finally {
				listener.dispose();
			}
		});
		this._pendingRequests.set(model.sessionId, rawResponsePromise);
		rawResponsePromise.finally(() => {
			this._pendingRequests.delete(model.sessionId);
		});
		return rawResponsePromise;
	}

	async removeRequest(sessionId: string, requestId: string): Promise<void> {
		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await model.waitForInitialization();
		const provider = this._providers.get(model.providerId);
		if (!provider) {
			throw new Error(`Unknown provider: ${model.providerId}`);
		}

		model.removeRequest(requestId);
		provider.removeRequest?.(model.session!, requestId);
	}

	async getSlashCommands(sessionId: string, token: CancellationToken): Promise<ISlashCommand[]> {
		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await model.waitForInitialization();
		const provider = this._providers.get(model.providerId);
		if (!provider) {
			throw new Error(`Unknown provider: ${model.providerId}`);
		}

		const serviceResults = this.chatSlashCommandService.getCommands().map(data => {
			return <ISlashCommand>{
				command: data.command,
				detail: data.detail,
				sortText: data.sortText,
				executeImmediately: data.executeImmediately
			};
		});

		const mainProviderRequest = provider.provideSlashCommands?.(model.session!, token);

		try {
			const providerResults = await mainProviderRequest;
			if (providerResults) {
				return providerResults.concat(serviceResults);
			}
			return serviceResults;

		} catch (e) {
			this.logService.error(e);
			return serviceResults;
		}
	}

	async sendRequestToProvider(sessionId: string, message: IChatDynamicRequest): Promise<void> {
		this.trace('sendRequestToProvider', `sessionId: ${sessionId}`);
		await this.sendRequest(sessionId, message.message);
	}

	getProviders(): string[] {
		return Array.from(this._providers.keys());
	}

	async addCompleteRequest(sessionId: string, message: string, response: IChatCompleteResponse): Promise<void> {
		this.trace('addCompleteRequest', `message: ${message}`);

		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await model.waitForInitialization();
		const parsedRequest = await this.instantiationService.createInstance(ChatRequestParser).parseChatRequest(sessionId, message);
		const request = model.addRequest(parsedRequest);
		if (typeof response.message === 'string') {
			model.acceptResponseProgress(request, { content: response.message });
		} else {
			for (const part of response.message) {
				const progress = 'inlineReference' in part ? part :
					isMarkdownString(part) ? { content: part.value } :
						{ treeData: part };
				model.acceptResponseProgress(request, progress, true);
			}
		}
		model.setResponse(request, {
			session: model.session!,
			errorDetails: response.errorDetails,
		});
		if (response.followups !== undefined) {
			model.setFollowups(request, response.followups);
		}
		model.completeResponse(request);
	}

	cancelCurrentRequestForSession(sessionId: string): void {
		this.trace('cancelCurrentRequestForSession', `sessionId: ${sessionId}`);
		this._pendingRequests.get(sessionId)?.cancel();
	}

	clearSession(sessionId: string): void {
		this.trace('clearSession', `sessionId: ${sessionId}`);
		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		this._persistedSessions[sessionId] = model.toJSON();

		model.dispose();
		this._sessionModels.delete(sessionId);
		this._pendingRequests.get(sessionId)?.cancel();
		this._onDidDisposeSession.fire({ sessionId });
	}

	registerProvider(provider: IChatProvider): IDisposable {
		this.trace('registerProvider', `Adding new chat provider`);

		if (this._providers.has(provider.id)) {
			throw new Error(`Provider ${provider.id} already registered`);
		}

		this._providers.set(provider.id, provider);
		this._hasProvider.set(true);

		Array.from(this._sessionModels.values())
			.filter(model => model.providerId === provider.id)
			// The provider may have been registered in the process of initializing this model. Only grab models that were deinitialized when the provider was unregistered
			.filter(model => model.initState === ChatModelInitState.Created)
			.forEach(model => this.reinitializeModel(model));

		return toDisposable(() => {
			this.trace('registerProvider', `Disposing chat provider`);
			this._providers.delete(provider.id);
			this._hasProvider.set(this._providers.size > 0);
			Array.from(this._sessionModels.values())
				.filter(model => model.providerId === provider.id)
				.forEach(model => model.deinitialize());
		});
	}

	hasProviders(): boolean {
		return this._providers.size > 0;
	}

	getProviderInfos(): IChatProviderInfo[] {
		return Array.from(this._providers.values()).map(provider => {
			return {
				id: provider.id,
				displayName: provider.displayName
			};
		});
	}

	transferChatSession(transferredSessionData: IChatTransferredSessionData, toWorkspace: URI): void {
		const model = Iterable.find(this._sessionModels.values(), model => model.sessionId === transferredSessionData.sessionId);
		if (!model) {
			throw new Error(`Failed to transfer session. Unknown session ID: ${transferredSessionData.sessionId}`);
		}

		const existingRaw: IChatTransfer[] = this.storageService.getObject(globalChatKey, StorageScope.PROFILE, []);
		existingRaw.push({
			chat: model.toJSON(),
			timestampInMilliseconds: Date.now(),
			toWorkspace: toWorkspace,
			inputValue: transferredSessionData.inputValue,
		});

		this.storageService.store(globalChatKey, JSON.stringify(existingRaw), StorageScope.PROFILE, StorageTarget.MACHINE);
		this.trace('transferChatSession', `Transferred session ${model.sessionId} to workspace ${toWorkspace.toString()}`);
	}
}
