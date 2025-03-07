/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { Iterable } from 'vs/base/common/iterator';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IChatMessage } from 'vs/workbench/contrib/chat/common/chatProvider';
import { IChatFollowup, IChatProgress, IChatResponseErrorDetails, IChatResponseProgressFileTreeData } from 'vs/workbench/contrib/chat/common/chatService';
import { IChatRequestVariableValue } from 'vs/workbench/contrib/chat/common/chatVariables';

//#region agent service, commands etc

export interface IChatAgent {
	id: string;
	metadata: IChatAgentMetadata;
	invoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: IChatMessage[], token: CancellationToken): Promise<IChatAgentResult>;
	provideFollowups?(sessionId: string, token: CancellationToken): Promise<IChatFollowup[]>;
	provideSlashCommands(token: CancellationToken): Promise<IChatAgentCommand[]>;
}

export interface IChatAgentFragment {
	content: string | { treeData: IChatResponseProgressFileTreeData };
}

export interface IChatAgentCommand {
	name: string;
	description: string;
}

export interface IChatAgentMetadata {
	description?: string;
	// subCommands: IChatAgentCommand[];
	requireCommand?: boolean; // Do some agents not have a default action?
	isDefault?: boolean; // The agent invoked when no agent is specified
	fullName?: string;
	icon?: URI;
}

export interface IChatAgentRequest {
	sessionId: string;
	requestId: string;
	command?: string;
	message: string;
	variables: Record<string, IChatRequestVariableValue[]>;
}

export interface IChatAgentResult {
	// delete, keep while people are still using the previous API
	followUp?: IChatFollowup[];
	errorDetails?: IChatResponseErrorDetails;
	timings?: {
		firstProgress: number;
		totalElapsed: number;
	};
}

export const IChatAgentService = createDecorator<IChatAgentService>('chatAgentService');

export interface IChatAgentService {
	_serviceBrand: undefined;
	readonly onDidChangeAgents: Event<void>;
	registerAgent(agent: IChatAgent): IDisposable;
	invokeAgent(id: string, request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: IChatMessage[], token: CancellationToken): Promise<IChatAgentResult>;
	getFollowups(id: string, sessionId: string, token: CancellationToken): Promise<IChatFollowup[]>;
	getAgents(): Array<IChatAgent>;
	getAgent(id: string): IChatAgent | undefined;
	getDefaultAgent(): IChatAgent | undefined;
	hasAgent(id: string): boolean;
	updateAgent(id: string, updateMetadata: IChatAgentMetadata): void;
}

export class ChatAgentService extends Disposable implements IChatAgentService {

	public static readonly AGENT_LEADER = '@';

	declare _serviceBrand: undefined;

	private readonly _agents = new Map<string, { agent: IChatAgent }>();

	private readonly _onDidChangeAgents = this._register(new Emitter<void>());
	readonly onDidChangeAgents: Event<void> = this._onDidChangeAgents.event;

	override dispose(): void {
		super.dispose();
		this._agents.clear();
	}

	registerAgent(agent: IChatAgent): IDisposable {
		if (this._agents.has(agent.id)) {
			throw new Error(`Already registered an agent with id ${agent.id}`);
		}
		this._agents.set(agent.id, { agent });
		this._onDidChangeAgents.fire();

		return toDisposable(() => {
			if (this._agents.delete(agent.id)) {
				this._onDidChangeAgents.fire();
			}
		});
	}

	updateAgent(id: string, updateMetadata: IChatAgentMetadata): void {
		const data = this._agents.get(id);
		if (!data) {
			throw new Error(`No agent with id ${id} registered`);
		}
		data.agent.metadata = { ...data.agent.metadata, ...updateMetadata };
		this._onDidChangeAgents.fire();
	}

	getDefaultAgent(): IChatAgent | undefined {
		return Iterable.find(this._agents.values(), a => !!a.agent.metadata.isDefault)?.agent;
	}

	getAgents(): Array<IChatAgent> {
		return Array.from(this._agents.values(), v => v.agent);
	}

	hasAgent(id: string): boolean {
		return this._agents.has(id);
	}

	getAgent(id: string): IChatAgent | undefined {
		const data = this._agents.get(id);
		return data?.agent;
	}

	async invokeAgent(id: string, request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: IChatMessage[], token: CancellationToken): Promise<IChatAgentResult> {
		const data = this._agents.get(id);
		if (!data) {
			throw new Error(`No agent with id ${id}`);
		}

		return await data.agent.invoke(request, progress, history, token);
	}

	async getFollowups(id: string, sessionId: string, token: CancellationToken): Promise<IChatFollowup[]> {
		const data = this._agents.get(id);
		if (!data) {
			throw new Error(`No agent with id ${id}`);
		}

		if (!data.agent.provideFollowups) {
			return [];
		}

		return data.agent.provideFollowups(sessionId, token);
	}
}
