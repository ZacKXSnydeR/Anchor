<script lang="ts">
  export let snapshots: string[] = [];
</script>

<ul>
  {#each snapshots as snapshot}
    <li>{snapshot}</li>
  {/each}
</ul>
