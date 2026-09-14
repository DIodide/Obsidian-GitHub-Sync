import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, Vault } from 'obsidian';
import { simpleGit, SimpleGit, CleanOptions, SimpleGitOptions } from 'simple-git';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async';

let simpleGitOptions: Partial<SimpleGitOptions>;


type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type LegacyNoticeLevelSetting = NoticeLevelSetting | 'WARNINGS';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';


interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	syncinterval: number;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
	additionalRepoPaths: string;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
	additionalRepoPaths: '',
}


export default class GHSyncPlugin extends Plugin {

	settings: GHSyncSettings;
	private syncInFlight: Promise<void> | null = null;
	private syncTimer: ReturnType<typeof setIntervalAsync> | null = null;

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR':
				return severity === 'ERROR';
			case 'WARNING':
				return severity === 'WARNING' || severity === 'ERROR';
			case 'ALL':
			default:
				return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (!this.shouldShowNotice(severity)) {
			return;
		}

		const text = message instanceof Error ? message.message : String(message);
		new Notice(text, timeout);
	}

	private showSyncSuccessNotice(extraRepoCount: number): void {
		if (!this.settings.showSyncSuccessNotice) {
			return;
		}

		const suffix = extraRepoCount > 0 ? ` (vault + ${extraRepoCount} extra repo${extraRepoCount > 1 ? 's' : ''})` : '';
		this.showNotice('github sync successful' + suffix, 'INFO');
	}

	// Expand ~ and vault-relative paths, then resolve symlinks so a repo
	// reachable through a symlinked folder inside the vault (e.g.
	// "#information") syncs at its real location.
	private expandRepoPath(rawPath: string): string | null {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');

		let p = rawPath.trim();
		if (p.length === 0) {
			return null;
		}
		if (p === '~' || p.startsWith('~/')) {
			p = path.join(os.homedir(), p.slice(1));
		}
		if (!path.isAbsolute(p)) {
			//@ts-ignore
			p = path.join(this.app.vault.adapter.getBasePath(), p);
		}
		try {
			return fs.realpathSync(p);
		} catch (e) {
			this.showNotice(`GitHub Sync: additional repo path not found: ${rawPath}`, 'ERROR', 10000);
			return null;
		}
	}

	private getAdditionalRepoPaths(): string[] {
		return this.settings.additionalRepoPaths
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#'));
	}

	// Sync one additional repository: add everything, commit, pull origin
	// main, push origin main. The repo's existing origin remote is used as
	// is. Returns true on success.
	async SyncAdditionalRepo(rawPath: string): Promise<boolean>
	{
		const repoPath = this.expandRepoPath(rawPath);
		if (!repoPath) {
			return false;
		}

		const repoGit: SimpleGit = simpleGit({
			baseDir: repoPath,
			binary: this.settings.gitLocation + "git",
			maxConcurrentProcesses: 6,
			trimmed: false,
		});

		const statusResult = await repoGit.status().catch(() => {
			this.showNotice(`GitHub Sync: ${rawPath} is not a Git repo or git binary cannot be found.`, 'ERROR', 10000);
			return null;
		});
		if (!statusResult) {
			return false;
		}

		const os = require("os");
		const path = require("path");
		const date = new Date();
		const msg = os.hostname() + " " + date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate() + ":" + date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds() + " (" + path.basename(repoPath) + ")";

		const clean = statusResult.isClean();
		if (!clean) {
			try {
				await repoGit.add(["-A"]).commit(msg);
			} catch (e) {
				this.showNotice(e, 'ERROR', 10000);
				return false;
			}
		}

		try {
			//@ts-ignore
			await repoGit.pull('origin', 'main', { '--no-rebase': null });
		} catch (e) {
			const conflictStatus = await repoGit.status().catch(() => null);
			if (conflictStatus && conflictStatus.conflicted.length > 0) {
				let conflictMsg = `Merge conflicts in ${rawPath}:`;
				for (const c of conflictStatus.conflicted) {
					conflictMsg += "\n\t" + c;
				}
				conflictMsg += "\nResolve them in that repo, then sync again.";
				this.showNotice(conflictMsg, 'WARNING');
			} else {
				this.showNotice(e, 'ERROR', 10000);
			}
			return false;
		}

		try {
			await repoGit.push('origin', 'main', ['-u']);
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return false;
		}

		return true;
	}

	// Upstream vault sync, unchanged in behavior. Returns true on success.
	async SyncVault(): Promise<boolean>
	{
		const remote = this.settings.remoteURL.trim();

		simpleGitOptions = {
			//@ts-ignore
		    baseDir: this.app.vault.adapter.getBasePath(),
		    binary: this.settings.gitLocation + "git",
		    maxConcurrentProcesses: 6,
		    trimmed: false,
		};
		const git = simpleGit(simpleGitOptions);

		let os = require("os");
		let hostname = os.hostname();

		let statusResult = await git.status().catch((e) => {
			this.showNotice("Vault is not a Git repo or git binary cannot be found.", 'ERROR', 10000);
			return; })

		if (!statusResult) {
			return false;
		}

		//@ts-ignore
		let clean = statusResult.isClean();

    	let date = new Date();
    	let msg = hostname + " " + date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate() + ":" + date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds();

		// git add .
		// git commit -m hostname-date-time
		if (!clean) {
			try {
				await git
					.add(["-A"])
		    		.commit(msg);
		    } catch (e) {
		    	this.showNotice(e, 'ERROR', 10000);
		    	return false;
		    }
		}

		// Preserve upstream tracking when updating the configured URL.
		try {
			const remotes = await git.getRemotes();
			if (remotes.some((remote) => remote.name === 'origin')) {
				await git.remote(['set-url', 'origin', remote]);
			} else {
				await git.addRemote('origin', remote);
			}
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return false;
		}
		// check if remote url valid by fetching
		try {
			await git.fetch();
		} catch (e) {
			this.showNotice(String(e) + "\nGitHub Sync: Fetch failed.", 'ERROR', 10000);
			return false;
		}

		try {
			await git.pull('origin', 'main', { '--no-rebase': null });
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return false;
		}

		// Retry already committed changes too; an up-to-date push is harmless.
		try {
			await git.push('origin', 'main', ['-u']);
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return false;
		}

		return true;
	}

	SyncNotes(): Promise<void> {
		if (!this.syncInFlight) {
			this.syncInFlight = this.syncAll().catch((e) => {
				this.showNotice(e, 'ERROR', 10000);
			}).finally(() => { this.syncInFlight = null; });
		}
		return this.syncInFlight;
	}

	private async syncAll(): Promise<void>
	{
		const vaultOk = await this.SyncVault();

		// Sync any additional repositories (e.g. a knowledge repo reachable
		// through a symlink inside the vault). Failures in one repo do not
		// block the others.
		let extraOk = 0;
		const extraPaths = this.getAdditionalRepoPaths();
		for (const p of extraPaths) {
			const ok = await this.SyncAdditionalRepo(p);
			if (ok) {
				extraOk += 1;
			}
		}

		if (vaultOk && extraOk === extraPaths.length) {
			this.showSyncSuccessNotice(extraOk);
		}
	}

	async CheckStatusOnStart() {
		try {
			const git = simpleGit({
				//@ts-ignore
				baseDir: this.app.vault.adapter.getBasePath(),
				binary: this.settings.gitLocation + 'git',
			});
			await git.fetch('origin');
			const counts = (await git.raw(['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main'])).trim().split(/\s+/).map(Number);
			const status = await git.status();
			if (counts[0] > 0 || counts[1] > 0 || !status.isClean()) {
				this.showNotice(`GitHub Sync: ${counts[0]} commits ahead, ${counts[1]} behind; ${status.isClean() ? 'working tree clean' : 'uncommitted changes'}. Click sync to synchronize all repositories.`, 'WARNING');
			} else {
				this.showNotice('GitHub Sync: vault up to date with remote.', 'INFO');
			}
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
		}
	}

	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', (evt: MouseEvent) => {
			this.SyncNotes();
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

		this.addCommand({
			id: 'github-sync-command',
			name: 'Sync with Remote',
			callback: () => {
				this.SyncNotes();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		if (!isNaN(this.settings.syncinterval))
		{
			let interval: number = this.settings.syncinterval;
			if (interval >= 1)
			{
				try {
					this.syncTimer = setIntervalAsync(async () => {
						await this.SyncNotes();
					}, interval * 60 * 1000);
					//this.registerInterval(setInterval(this.SyncNotes, interval * 6 * 1000));
					this.showNotice("Auto sync enabled", 'INFO');
				} catch (e) {

				}
			}
		}

		if (this.settings.isSyncOnLoad) {
			await this.SyncNotes();
		} else if (this.settings.checkStatusOnLoad) {
			await this.CheckStatusOnStart();
		}
	}

	onunload() {
		if (this.syncTimer) {
			void clearIntervalAsync(this.syncTimer);
			this.syncTimer = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') {
			this.settings.noticeLevel = 'WARNING';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;

	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const howto = containerEl.createEl("div", { cls: "howto" });
		howto.createEl("div", { text: "How to use this plugin", cls: "howto_title" });
		howto.createEl("small", { text: "Grab your GitHub repository's HTTPS or SSH url and paste it into the settings here. If you're not authenticated, the first sync with this plugin should prompt you to authenticate. If you've already setup SSH on your device with GitHub, you won't need to authenticate - just paste your repo's SSH url into the settings here.", cls: "howto_text" });
		howto.createEl("br");
        const linkEl = howto.createEl('p');
        linkEl.createEl('span', { text: 'See the ' });
        linkEl.createEl('a', { href: 'https://github.com/DIodide/Obsidian-GitHub-Sync/blob/main/README.md', text: 'README' });
        linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('Additional repositories')
			.setDesc('One path per line. Each is a separate git repository that is committed, pulled, and pushed to its own origin main whenever the vault syncs. Paths may be absolute, start with ~, or be vault-relative; symlinks (e.g. a linked folder inside the vault) are resolved to the real repository. Lines starting with # are ignored.')
			.addTextArea(text => text
				.setPlaceholder('~/information/portfolio')
				.setValue(this.plugin.settings.additionalRepoPaths)
				.onChange(async (value) => {
					this.plugin.settings.additionalRepoPaths = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-textarea'));

		new Setting(containerEl)
			.setName('git binary location')
			.setDesc('This is optional! Set this only if git is not findable via your system PATH, then provide its location here. See README for more info.')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text2'));

		new Setting(containerEl)
			.setName('Notice level')
			.setDesc('Choose which GitHub Sync notices are shown in the Obsidian UI.')
			.addDropdown((dropdown) => dropdown
				.addOption('ALL', 'ALL')
				.addOption('WARNING', 'WARNING')
				.addOption('ERROR', 'ERROR')
				.setValue(this.plugin.settings.noticeLevel)
				.onChange(async (value: NoticeLevelSetting) => {
					this.plugin.settings.noticeLevel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide Success Message')
			.setDesc('Hide the single success notice shown when a sync finishes successfully.')
			.addToggle((toggle) => toggle
				.setValue(!this.plugin.settings.showSyncSuccessNotice)
				.onChange(async (value) => {
					this.plugin.settings.showSyncSuccessNotice = !value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Check status on startup')
			.setDesc('Check the vault for unpushed commits, remote commits, and uncommitted changes on startup.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.checkStatusOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.checkStatusOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Sync the vault and all additional repositories when Obsidian starts.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.isSyncOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.isSyncOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync at interval')
			.setDesc('Set minute interval after which your vault is synced automatically. Auto sync is disabled if this field is left empty or not a positive integer. Restart Obsidan to take effect.')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncinterval))
				.onChange(async (value) => {
					this.plugin.settings.syncinterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
