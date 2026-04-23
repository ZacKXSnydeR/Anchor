<script lang="ts">
  export let conversations: string[] = [];
</script>

<ul>
  {#each conversations as conversation}
    <li>{conversation}</li>
  {/each}
</ul>
